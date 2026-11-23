import { jetstream } from '@nats-io/jetstream'
import type { LogisticsEvent } from '@tt/contracts'
import { createPool } from '@tt/db'
import { consumeEvents, LOGISTICS_STREAM, setupNats, type ConsumeHandle } from '@tt/messaging'
import { startNats, type TestNats } from '@tt/messaging/testing'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEventHandler } from '../application/handle-event.js'
import { createProcessEvent } from '../application/process-event.js'
import { createGetAnomalies, createGetHistory, createGetTracking } from '../application/read-tracking.js'
import { createHealthChecks } from '../health.js'
import { parcel, registered, SHIPMENT_ID } from '../test-events.js'
import { clearTables, memoryLog, publish, startTestDatabase, waitUntilAcked, type TestDatabase } from '../test-support.js'
import { buildApp } from './app.js'

const OTHER_SHIPMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SUFFIXES = ['', '/history', '/anomalies']

let db: TestDatabase
let nats: TestNats
// The reads run on a pool that refuses every write.
let readPool: pg.Pool
let app: FastifyInstance
let consumer: ConsumeHandle | undefined

/** A service pool whose sessions have these settings. */
function createPoolWith(...settings: string[]): pg.Pool {
  const options = settings.map((setting) => `-c ${setting}`).join(' ')
  return createPool(`${db.serviceUrl}?options=${encodeURIComponent(options)}`)
}

function buildTestApp(pool: pg.Pool): Promise<FastifyInstance> {
  return buildApp({
    getTracking: createGetTracking({ pool }),
    getHistory: createGetHistory({ pool }),
    getAnomalies: createGetAnomalies({ pool }),
    checks: createHealthChecks({ pool, nc: nats.nc }),
    logger: false,
  })
}

beforeAll(async () => {
  ;[db, nats] = await Promise.all([startTestDatabase(), startNats()])
  readPool = createPoolWith('default_transaction_read_only=on')
  app = await buildTestApp(readPool)
})

afterAll(async () => {
  await app?.close()
  await readPool?.end()
  await Promise.all([db?.stop(), nats?.stop()])
})

beforeEach(async () => {
  await clearTables(db.owner)
  // Deleting the stream also deletes its consumers; sequences start at 1 again.
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
  await setupNats(nats.jsm)
})

afterEach(async () => {
  await consumer?.stop()
  consumer = undefined
})

/** Publishes to the stream and waits until the real "tracking" consumer has processed everything. */
async function processAll(events: LogisticsEvent[], pool: pg.Pool = db.pool): Promise<void> {
  const handler = createEventHandler({ processEvent: createProcessEvent({ pool }), log: memoryLog().log })
  consumer ??= await consumeEvents(jetstream(nats.nc), 'tracking', handler)
  await publish(nats, ...events)
  await waitUntilAcked(nats)
}

function get(suffix = '', shipmentId = SHIPMENT_ID, from = app) {
  return from.inject({ method: 'GET', url: `/tracking/${shipmentId}${suffix}` })
}

async function getOk(suffix = '', shipmentId = SHIPMENT_ID) {
  const res = await get(suffix, shipmentId)
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}

async function historyIds(shipmentId = SHIPMENT_ID): Promise<string[]> {
  return (await getOk('/history', shipmentId)).events.map((event: { eventId: string }) => event.eventId)
}

// In R2 order. Neither eventId nor receivedAt has the order of the history: the
// accepted scan has the same occurredAt as the registration (only the lifecycle
// phase orders them) and arrived last.
function journey() {
  return {
    registration: registered('2026-10-28T08:00:00Z', { eventId: 'eeeeeeee-0000-4000-8000-000000000001' }),
    accepted: parcel('parcel.accepted', '2026-10-28T08:00:00Z', {
      eventId: 'dddddddd-0000-4000-8000-000000000002',
      facilityId: 'DEPOT-PRAHA',
      receivedAt: '2026-10-28T15:00:00Z',
    }),
    atHub: parcel('parcel.arrived_at_hub', '2026-10-28T09:30:00Z', {
      eventId: 'aaaaaaaa-0000-4000-8000-000000000003',
      receivedAt: '2026-10-28T09:31:12.345Z',
    }),
    outForDelivery: parcel('parcel.out_for_delivery', '2026-10-28T12:00:00Z', {
      eventId: 'cccccccc-0000-4000-8000-000000000004',
      receivedAt: '2026-10-28T12:00:02Z',
    }),
    delivered: parcel('parcel.delivered', '2026-10-28T14:00:00.250Z', {
      eventId: 'bbbbbbbb-0000-4000-8000-000000000005',
      facilityId: 'DOOR-BRNO',
      receivedAt: '2026-10-28T14:00:01Z',
    }),
  }
}

const journeyIds = () => Object.values(journey()).map((event) => event.eventId)

function anomalyAfterDelivery() {
  return parcel('parcel.arrived_at_hub', '2026-10-29T08:15:00Z', {
    facilityId: 'DEPOT-OSTRAVA',
    receivedAt: '2026-10-29T08:15:04Z',
  })
}

describe('a full journey', () => {
  it('returns the state, the history in R2 order and empty anomalies', async () => {
    const { registration, accepted, atHub, outForDelivery, delivered } = journey()
    const before = Date.now()

    await processAll([registration, accepted, atHub, outForDelivery, delivered])

    const tracking = await getOk()
    expect(tracking).toEqual({
      shipmentId: SHIPMENT_ID,
      trackingNumber: 'PF-4821093375',
      status: 'DELIVERED',
      lastLocation: 'DOOR-BRNO',
      lastEventAt: '2026-10-28T14:00:00.250Z',
      deliveredAt: '2026-10-28T14:00:00.250Z',
      updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
    })
    // Processing time, not business time.
    expect(Date.parse(tracking.updatedAt)).toBeGreaterThan(before - 60_000)

    const entry = { facilityId: 'DEPOT-BRNO', isAnomaly: false }
    expect(await getOk('/history')).toEqual({
      shipmentId: SHIPMENT_ID,
      events: [
        {
          ...entry,
          eventId: registration.eventId,
          eventType: 'shipment.registered',
          status: 'REGISTERED',
          occurredAt: '2026-10-28T08:00:00.000Z',
          receivedAt: '2026-10-28T08:00:00.000Z',
          facilityId: null,
        },
        {
          ...entry,
          eventId: accepted.eventId,
          eventType: 'parcel.accepted',
          status: 'ACCEPTED',
          occurredAt: '2026-10-28T08:00:00.000Z',
          receivedAt: '2026-10-28T15:00:00.000Z',
          facilityId: 'DEPOT-PRAHA',
        },
        {
          ...entry,
          eventId: atHub.eventId,
          eventType: 'parcel.arrived_at_hub',
          status: 'AT_HUB',
          occurredAt: '2026-10-28T09:30:00.000Z',
          receivedAt: '2026-10-28T09:31:12.345Z',
        },
        {
          ...entry,
          eventId: outForDelivery.eventId,
          eventType: 'parcel.out_for_delivery',
          status: 'OUT_FOR_DELIVERY',
          occurredAt: '2026-10-28T12:00:00.000Z',
          receivedAt: '2026-10-28T12:00:02.000Z',
        },
        {
          ...entry,
          eventId: delivered.eventId,
          eventType: 'parcel.delivered',
          status: 'DELIVERED',
          occurredAt: '2026-10-28T14:00:00.250Z',
          receivedAt: '2026-10-28T14:00:01.000Z',
          facilityId: 'DOOR-BRNO',
        },
      ],
    })

    expect(await getOk('/anomalies')).toEqual({ shipmentId: SHIPMENT_ID, afterDelivery: [], conflicts: [] })
  })

  it('returns a REGISTERED shipment without location and delivery', async () => {
    await processAll([journey().registration])

    expect(await getOk()).toMatchObject({
      status: 'REGISTERED',
      lastLocation: null,
      lastEventAt: '2026-10-28T08:00:00.000Z',
      deliveredAt: null,
    })
  })

  it('returns lowercase ids for an uppercase path and for events published with uppercase ids', async () => {
    const { registration, atHub } = journey()
    const upper = <T extends LogisticsEvent>(event: T): T => ({
      ...event,
      eventId: event.eventId.toUpperCase(),
      shipmentId: event.shipmentId.toUpperCase(),
      correlationId: event.correlationId.toUpperCase(),
    })

    await processAll([upper(registration), upper(atHub)])

    for (const suffix of SUFFIXES) {
      expect((await getOk(suffix, SHIPMENT_ID.toUpperCase())).shipmentId).toBe(SHIPMENT_ID)
    }
    expect(await historyIds(SHIPMENT_ID.toUpperCase())).toEqual([registration.eventId, atHub.eventId])
  })
})

describe('AC-03: out of order', () => {
  it('returns the same state and history as in order', async () => {
    const { registration, accepted, atHub, outForDelivery, delivered } = journey()

    await processAll([registration, delivered, atHub, accepted, outForDelivery])

    expect(await getOk()).toMatchObject({ status: 'DELIVERED', lastEventAt: '2026-10-28T14:00:00.250Z' })
    const { events } = await getOk('/history')
    expect(events.map((event: { eventId: string }) => event.eventId)).toEqual(journeyIds())
    // Earlier than the delivery in R2 order, so not anomalies (R6).
    expect((await getOk('/anomalies')).afterDelivery).toEqual([])
  })
})

describe('AC-02: duplicates', () => {
  it('counts a duplicate once, with the earliest receivedAt, and does not list it as a conflict', async () => {
    const { registration, atHub } = journey()

    await processAll([registration, { ...atHub, receivedAt: '2026-10-28T10:00:00Z' }, atHub])

    const { events } = await getOk('/history')
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ eventId: atHub.eventId, receivedAt: '2026-10-28T09:31:12.345Z' })
    expect((await getOk('/anomalies')).conflicts).toEqual([])
  })
})

describe('AC-11: scan before the registration', () => {
  it('returns 404 everywhere while only scans exist, then the full history', async () => {
    const { registration, accepted, atHub } = journey()
    // A conflict does not make the shipment known either.
    await processAll([atHub, accepted, { ...atHub, data: { ...atHub.data, scannerId: 'SCANNER-99' } }])

    for (const suffix of SUFFIXES) {
      const res = await get(suffix)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Shipment ${SHIPMENT_ID} not found.` } })
    }

    await processAll([registration])

    expect(await getOk()).toMatchObject({ status: 'AT_HUB', lastLocation: 'DEPOT-BRNO' })
    expect(await historyIds()).toEqual([registration.eventId, accepted.eventId, atHub.eventId])
    expect((await getOk('/anomalies')).conflicts).toMatchObject([{ eventId: atHub.eventId, streamSequence: 3 }])
  })

  it('returns 404 for a shipment without any event, also next to a known one', async () => {
    await processAll([journey().registration])

    for (const suffix of SUFFIXES) expect((await get(suffix, OTHER_SHIPMENT_ID)).statusCode).toBe(404)
  })
})

describe('anomalies after delivery', () => {
  it('lists only the anomalies, keeps them in the history and leaves the state DELIVERED', async () => {
    const late = anomalyAfterDelivery()
    const later = parcel('parcel.out_for_delivery', '2026-10-29T10:00:00Z')

    // Published in the opposite order.
    await processAll([...Object.values(journey()), later, late])

    expect(await getOk()).toMatchObject({ status: 'DELIVERED', lastLocation: 'DOOR-BRNO' })
    const { events } = await getOk('/history')
    expect(events.map((event: { isAnomaly: boolean }) => event.isAnomaly)).toEqual([
      false, false, false, false, false, true, true,
    ])
    const { afterDelivery, conflicts } = await getOk('/anomalies')
    expect(afterDelivery).toEqual(events.slice(5))
    expect(afterDelivery).toMatchObject([
      {
        eventId: late.eventId,
        eventType: 'parcel.arrived_at_hub',
        status: 'AT_HUB',
        occurredAt: '2026-10-29T08:15:00.000Z',
        receivedAt: '2026-10-29T08:15:04.000Z',
        facilityId: 'DEPOT-OSTRAVA',
        isAnomaly: true,
      },
      { eventId: later.eventId, isAnomaly: true },
    ])
    expect(conflicts).toEqual([])
  })

  it('keeps shipments apart', async () => {
    const other = { shipmentId: OTHER_SHIPMENT_ID }
    const registration = registered('2026-10-28T08:05:00Z', other)

    await processAll([...Object.values(journey()), anomalyAfterDelivery(), registration])

    expect(await historyIds(OTHER_SHIPMENT_ID)).toEqual([registration.eventId])
    expect(await getOk('/anomalies', OTHER_SHIPMENT_ID)).toEqual({ ...other, afterDelivery: [], conflicts: [] })
  })
})

describe('AC-12: conflicts', () => {
  it('lists every conflicting copy in stream order with its own receivedAt', async () => {
    const { registration, atHub } = journey()
    const scanner = { ...atHub, receivedAt: '2026-10-28T10:02:41.918Z', data: { ...atHub.data, scannerId: 'SCANNER-99' } }
    const facility = { ...atHub, receivedAt: '2026-10-28T09:00:00Z', data: { ...atHub.data, facilityId: 'DEPOT-OSTRAVA' } }

    await processAll([registration, atHub, scanner, facility])

    expect((await getOk('/anomalies')).conflicts).toEqual([
      {
        eventId: atHub.eventId,
        streamSequence: 3,
        receivedAt: '2026-10-28T10:02:41.918Z',
        differingFields: ['data.scannerId'],
      },
      {
        eventId: atHub.eventId,
        streamSequence: 4,
        receivedAt: '2026-10-28T09:00:00.000Z',
        differingFields: ['data.facilityId'],
      },
    ])
    expect(await historyIds()).toEqual([registration.eventId, atHub.eventId])
    expect((await getOk()).lastLocation).toBe('DEPOT-BRNO')
  })

  it('lists a conflict under both shipments when their shipmentIds differ', async () => {
    const { registration, atHub } = journey()
    const other = registered('2026-10-28T08:05:00Z', { shipmentId: OTHER_SHIPMENT_ID })
    const copy = {
      ...atHub,
      shipmentId: OTHER_SHIPMENT_ID,
      correlationId: OTHER_SHIPMENT_ID,
      receivedAt: '2026-10-28T10:00:00Z',
    }

    await processAll([registration, other, atHub, copy])

    const conflicts = [
      {
        eventId: atHub.eventId,
        streamSequence: 4,
        receivedAt: '2026-10-28T10:00:00.000Z',
        differingFields: ['correlationId', 'shipmentId'],
      },
    ]
    for (const shipmentId of [SHIPMENT_ID, OTHER_SHIPMENT_ID]) {
      expect(await getOk('/anomalies', shipmentId)).toEqual({ shipmentId, afterDelivery: [], conflicts })
    }
    // Only the kept copy is in a history.
    expect(await historyIds()).toEqual([registration.eventId, atHub.eventId])
    expect(await historyIds(OTHER_SHIPMENT_ID)).toEqual([other.eventId])
  })
})

describe('order', () => {
  it('does not depend on the order in which the rows are stored', async () => {
    const { atHub } = journey()
    const copies = ['SCANNER-98', 'SCANNER-99'].map((scannerId) => ({ ...atHub, data: { ...atHub.data, scannerId } }))
    const late = [anomalyAfterDelivery(), parcel('parcel.out_for_delivery', '2026-10-29T10:00:00Z')]
    await processAll([...Object.values(journey()), ...late, ...copies])
    const before = [await getOk('/history'), await getOk('/anomalies')]
    expect(before[1].conflicts.map((c: { streamSequence: number }) => c.streamSequence)).toEqual([8, 9])

    // An updated row is stored after the others, and a primary key index would hide that.
    await db.owner.query('UPDATE tracking_history SET status = status WHERE position IN (1, 6)')
    await db.owner.query('UPDATE tracking_conflicts SET received_at = received_at WHERE stream_sequence = 8')
    const pool = createPoolWith('enable_indexscan=off', 'enable_indexonlyscan=off', 'enable_bitmapscan=off')
    const seqScanApp = await buildTestApp(pool)
    try {
      const after = [await get('/history', SHIPMENT_ID, seqScanApp), await get('/anomalies', SHIPMENT_ID, seqScanApp)]
      expect(after.map((res) => res.json())).toEqual(before)
    } finally {
      await seqScanApp.close()
      await pool.end()
    }
  })
})

describe('consistent reads', () => {
  it.each([
    ['/history', 'tracking_history'],
    ['/anomalies', 'tracking_history'],
    ['/anomalies', 'tracking_conflicts'],
  ])('GET ...%s never mixes rows from before and after a change while it waits for %s', async (suffix, table) => {
    const { atHub } = journey()
    const conflicting = { ...atHub, data: { ...atHub.data, scannerId: 'SCANNER-99' } }
    await processAll([...Object.values(journey()), anomalyAfterDelivery(), conflicting])
    const { afterDelivery, conflicts } = await getOk('/anomalies')
    expect([afterDelivery.length, conflicts.length]).toEqual([1, 1])

    const writer = await db.owner.connect()
    try {
      await writer.query('BEGIN')
      // The read stops at this table, after it could already have read another one.
      await writer.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`)
      const reading = get(suffix)
      await vi.waitFor(async () => {
        const { rows } = await db.owner.query('SELECT 1 FROM pg_locks WHERE NOT granted AND relation = $1::regclass', [table])
        expect(rows).toHaveLength(1)
      })
      // As a re-projection does when the shipment stops being known.
      await writer.query('DELETE FROM tracking_history')
      await writer.query('DELETE FROM tracking_conflicts')
      await writer.query('DELETE FROM shipment_tracking')
      await writer.query('COMMIT')

      // Everything is from after the change: not 200 with a list that is empty or left over.
      expect((await reading).statusCode).toBe(404)
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
    }
  })
})

describe('database stopped', () => {
  it('returns 503 for the reads and readiness, while live stays 200', async () => {
    const ownDb = await startTestDatabase({ restartable: true })
    const ownApp = await buildTestApp(ownDb.pool)
    try {
      await processAll([journey().registration], ownDb.pool)
      for (const suffix of SUFFIXES) expect((await get(suffix, SHIPMENT_ID, ownApp)).statusCode).toBe(200)

      await ownDb.postgres.stopServer()

      for (const suffix of SUFFIXES) {
        const res = await get(suffix, SHIPMENT_ID, ownApp)
        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({
          error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'The service is temporarily unavailable. Retry later.' },
        })
      }
      const ready = await ownApp.inject({ method: 'GET', url: '/health/ready' })
      expect(ready.statusCode).toBe(503)
      expect(ready.json()).toEqual({ status: 'not_ready', checks: { database: 'failed', nats: 'ok' } })
      const live = await ownApp.inject({ method: 'GET', url: '/health/live' })
      expect(live.statusCode).toBe(200)
      expect(live.json()).toEqual({ status: 'ok' })
    } finally {
      await ownApp.close()
      await ownDb.stop()
    }
  }, 60_000)
})
