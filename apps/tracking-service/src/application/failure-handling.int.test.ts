import { jetstream } from '@nats-io/jetstream'
import type { SlaBreachedEvent } from '@tt/contracts'
import { LOGISTICS_STREAM, publishEvent, setupNats, type ConsumeHandle } from '@tt/messaging'
import { startNats, type TestNats } from '@tt/messaging/testing'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startTrackingConsumer } from '../consumer.js'
import { createHealthChecks } from '../health.js'
import { buildApp } from '../http/app.js'
import { parcel, registered, SHIPMENT_ID } from '../test-events.js'
import {
  clearTables,
  memoryLog,
  publish,
  quarantinedEvents,
  readModel,
  receivedMessages,
  startTestDatabase,
  TEST_TIMING,
  waitUntilAcked,
  type TestDatabase,
} from '../test-support.js'
import { createListQuarantine, createQuarantine } from './quarantine.js'
import { createGetAnomalies, createGetHistory, createGetTracking } from './read-tracking.js'

// ADR-0015 with the real Tracking consumer, its quarantine and its HTTP API.

let db: TestDatabase
let nats: TestNats
let app: FastifyInstance
let consumer: ConsumeHandle | undefined
let logged: ReturnType<typeof memoryLog>

beforeAll(async () => {
  ;[db, nats] = await Promise.all([startTestDatabase({ restartable: true }), startNats()])
  app = await buildTrackingApp(db.pool)
})

afterAll(async () => {
  await app?.close()
  await Promise.all([db?.stop(), nats?.stop()])
})

beforeEach(async () => {
  await db.postgres.startServer()
  await clearTables(db.owner)
  // Deleting the stream also deletes its consumers; sequences start at 1 again.
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
  await setupNats(nats.jsm)
  logged = memoryLog()
})

afterEach(async () => {
  await consumer?.stop()
  consumer = undefined
})

function buildTrackingApp(pool: pg.Pool): Promise<FastifyInstance> {
  return buildApp({
    getTracking: createGetTracking({ pool }),
    getHistory: createGetHistory({ pool }),
    getAnomalies: createGetAnomalies({ pool }),
    listQuarantine: createListQuarantine({ pool }),
    checks: createHealthChecks({ pool, nc: nats.nc }),
    logger: false,
  })
}

async function startConsuming(): Promise<void> {
  consumer = await startTrackingConsumer({ js: jetstream(nats.nc), pool: db.pool, log: logged.log, timing: TEST_TIMING })
}

const consumerInfo = () => nats.jsm.consumers.info(LOGISTICS_STREAM.name, 'tracking')
const linesWith = (msg: string) => logged.lines.filter((line) => line.msg === msg)

async function getQuarantine(query = '') {
  const res = await app.inject({ method: 'GET', url: `/quarantine${query}` })
  expect(res.statusCode).toBe(200)
  return res.json().messages as Record<string, unknown>[]
}

describe('a. Postgres stopped while messages arrive', () => {
  it('quarantines and loses nothing, uses up no deliveries, and processes everything once Postgres is back', async () => {
    // A short ack_wait for this test only (declared: 30 s): the wait below outlasts it,
    // so a message survives only through the "working" signals.
    await nats.jsm.consumers.update(LOGISTICS_STREAM.name, 'tracking', { ack_wait: 2_000_000_000 })
    await startConsuming()
    await db.postgres.stopServer()
    let restarted = false
    try {
      const events = [
        registered('2026-10-28T08:00:00Z'),
        parcel('parcel.accepted', '2026-10-28T08:15:00Z'),
        parcel('parcel.arrived_at_hub', '2026-10-28T09:30:00Z'),
      ]
      await publish(nats, ...events)

      await new Promise((resolve) => setTimeout(resolve, 4_000))
      const during = await consumerInfo()
      // One message in hand, retried in process; the others wait in the stream.
      expect(during.delivered.consumer_seq).toBe(1)
      expect(during.num_ack_pending).toBe(1)
      expect(during.num_pending).toBe(2)
      expect(during.num_redelivered).toBe(0)
      expect(linesWith('transient error, retrying the message').length).toBeGreaterThan(3)

      await db.postgres.startServer()
      restarted = true
      await waitUntilAcked(nats)

      const after = await consumerInfo()
      // Three messages, three deliveries: no delivery was used up by the outage.
      expect(after.delivered.consumer_seq).toBe(3)
      expect(after.num_redelivered).toBe(0)
      expect(await quarantinedEvents(db.pool)).toEqual([])
      expect((await receivedMessages(db.pool)).map((row) => row.event_id)).toEqual(events.map((e) => e.eventId))
      expect((await readModel(db.pool, SHIPMENT_ID))?.state.status).toBe('AT_HUB')
      expect(linesWith('message processing recovered')).toHaveLength(1)
    } finally {
      if (!restarted) await db.postgres.startServer()
    }
  }, 40_000)
})

describe('b. invalid messages', () => {
  it('are quarantined as INVALID, listed by GET /quarantine and acked; other messages are processed', async () => {
    await startConsuming()
    // Not JSON, with a NUL and a byte that is not UTF-8.
    const notJson = Uint8Array.from([0x7b, 0x00, 0xff, 0x7d])
    await nats.js.publish('logistics.parcel.accepted.v1', notJson)
    const badEvent = { ...parcel('parcel.arrived_at_hub', '2026-10-28T09:30:00Z'), shipmentId: 'unknown' }
    const badJson = JSON.stringify(badEvent)
    await nats.js.publish('logistics.parcel.arrived_at_hub.v1', badJson)
    const registration = registered('2026-10-28T08:00:00Z')
    await publish(nats, registration)

    await waitUntilAcked(nats)

    expect((await readModel(db.pool, SHIPMENT_ID))?.state.status).toBe('REGISTERED')
    const info = await consumerInfo()
    expect(info.delivered.consumer_seq).toBe(3)
    expect(info.num_redelivered).toBe(0)

    const rows = await quarantinedEvents(db.pool)
    expect(rows.map((row) => [row.reason, row.stream_sequence, row.subject, row.event_id, row.shipment_id])).toEqual([
      ['INVALID', '1', 'logistics.parcel.accepted.v1', null, null],
      ['INVALID', '2', 'logistics.parcel.arrived_at_hub.v1', badEvent.eventId, null],
    ])
    expect(rows[0].raw_message).toEqual(Buffer.from(notJson))
    expect(rows[0].details).toMatch(/^Not JSON: /)
    expect(rows[0].details).not.toContain('\u0000')
    expect(rows[1].raw_message.toString()).toBe(badJson)
    expect(rows[1].details).toBe('shipmentId: Invalid UUID')

    const listed = await getQuarantine()
    expect(listed).toMatchObject([
      { reason: 'INVALID', streamSequence: 2, eventId: badEvent.eventId, shipmentId: null, rawMessage: badJson },
      { reason: 'INVALID', streamSequence: 1, eventId: null, rawMessage: '{\u0000�}' },
    ])
    expect(await getQuarantine('?reason=INVALID&limit=1')).toMatchObject([{ streamSequence: 2 }])
    expect(await getQuarantine('?reason=PROCESSING_FAILED')).toEqual([])
  })
})

describe('c. a poison message', () => {
  it('is quarantined as PROCESSING_FAILED after 5 deliveries, and other messages are processed meanwhile', async () => {
    await startConsuming()
    // A valid event that Tracking does not consume, on a subject it does: a permanent error.
    const poison: SlaBreachedEvent = {
      ...parcel('parcel.delivered', '2026-10-28T14:00:00Z'),
      eventType: 'sla.breached',
      producer: 'sla-monitoring',
      data: {
        incidentId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        expectedDeliveryAt: '2026-10-29T16:00:00Z',
        effectiveDeadline: '2026-10-29T18:00:00Z',
        reason: 'NOT_DELIVERED_IN_TIME',
        deliveredAt: null,
      },
    }
    await publishEvent(nats.js, poison, { subject: 'logistics.parcel.delivered.v1', deduplicate: false })
    const registration = registered('2026-10-28T08:00:00Z')
    await publish(nats, registration)

    // The registration does not wait for the poison message.
    await vi.waitFor(async () => expect(await receivedMessages(db.pool)).toHaveLength(1), { timeout: 5_000 })
    expect(await quarantinedEvents(db.pool)).toEqual([])

    await waitUntilAcked(nats)

    const rows = await quarantinedEvents(db.pool)
    expect(rows).toMatchObject([
      {
        reason: 'PROCESSING_FAILED',
        stream_sequence: '1',
        subject: 'logistics.parcel.delivered.v1',
        event_id: poison.eventId,
        shipment_id: SHIPMENT_ID,
        details: 'Unexpected sla.breached on logistics.parcel.delivered.v1',
      },
    ])
    expect(JSON.parse(rows[0].raw_message.toString())).toEqual(poison)
    // 5 deliveries of the poison message and 1 of the registration.
    expect((await consumerInfo()).delivered.consumer_seq).toBe(6)
    expect(linesWith('permanent error, message naked for a later delivery').map((l) => l.deliveryCount)).toEqual([
      1, 2, 3, 4,
    ])
    expect(await getQuarantine('?reason=PROCESSING_FAILED')).toMatchObject([
      { streamSequence: 1, eventId: poison.eventId, shipmentId: SHIPMENT_ID },
    ])
    // Not in received_messages (ADR-0014 amendment).
    expect((await receivedMessages(db.pool)).map((row) => row.event_id)).toEqual([registration.eventId])
  }, 20_000)
})

describe('the quarantine after a stream reset', () => {
  const record = (raw: string) => ({
    reason: 'INVALID' as const,
    subject: 'logistics.parcel.accepted.v1',
    streamSequence: 1,
    rawMessage: new TextEncoder().encode(raw),
    eventId: null,
    shipmentId: null,
    details: 'Not JSON',
  })

  it('takes the same message again as already quarantined, but rejects another one with the same stream sequence', async () => {
    const quarantine = createQuarantine({ pool: db.pool })
    await quarantine(record('{one'))

    await expect(quarantine(record('{one'))).resolves.toBeUndefined()
    await expect(quarantine(record('{two'))).rejects.toThrow(
      'Stream sequence 1 is already quarantined with another message. ' +
        'The stream and tracking_db must be reset together (ADR-0014).',
    )
    expect(await quarantinedEvents(db.pool)).toHaveLength(1)
  })

  it('pauses the consumer instead of acking the other message', async () => {
    await createQuarantine({ pool: db.pool })(record('{from the old stream'))
    await startConsuming()

    await nats.js.publish('logistics.parcel.accepted.v1', '{from the new stream')

    await vi.waitFor(
      () => expect(linesWith('transient error, retrying the message').length).toBeGreaterThanOrEqual(2),
      { timeout: 5_000 },
    )
    const info = await consumerInfo()
    expect(info.ack_floor.stream_seq).toBe(0)
    expect(info.num_ack_pending).toBe(1)
    expect((await quarantinedEvents(db.pool)).map((row) => row.raw_message.toString())).toEqual(['{from the old stream'])
  })
})

describe('d. a statement over the time limit', () => {
  it('is a transient error in the consumer: retried in process, no delivery used up', async () => {
    await startConsuming()
    const blocker = await db.owner.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE received_messages IN ACCESS EXCLUSIVE MODE')
      await publish(nats, registered('2026-10-28T08:00:00Z'))

      await vi.waitFor(() => expect(linesWith('transient error, retrying the message')).not.toHaveLength(0), {
        timeout: 10_000,
        interval: 100,
      })
      expect(linesWith('transient error, retrying the message')[0]).toMatchObject({
        streamSequence: 1,
        deliveryCount: 1,
        err: { type: 'DatabaseUnavailableError' },
      })
      await blocker.query('COMMIT')
    } finally {
      blocker.release()
    }

    await waitUntilAcked(nats)
    const info = await consumerInfo()
    expect(info.delivered.consumer_seq).toBe(1)
    expect(await quarantinedEvents(db.pool)).toEqual([])
    expect(await receivedMessages(db.pool)).toHaveLength(1)
  }, 30_000)

  it('is 503 DEPENDENCY_UNAVAILABLE in an HTTP read', async () => {
    const blocker = await db.owner.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE shipment_tracking, quarantined_events IN ACCESS EXCLUSIVE MODE')

      const started = Date.now()
      const [tracking, quarantine] = await Promise.all([
        app.inject({ method: 'GET', url: `/tracking/${SHIPMENT_ID}` }),
        app.inject({ method: 'GET', url: '/quarantine' }),
      ])

      expect(Date.now() - started).toBeGreaterThanOrEqual(4_900)
      for (const res of [tracking, quarantine]) {
        expect(res.statusCode).toBe(503)
        expect(res.json()).toMatchObject({ error: { code: 'DEPENDENCY_UNAVAILABLE' } })
      }
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
  }, 30_000)
})
