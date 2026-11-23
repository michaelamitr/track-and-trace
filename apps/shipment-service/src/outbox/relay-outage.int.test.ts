import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { JetStreamClient } from '@nats-io/jetstream'
import { uncaughtErrorsDuring } from '@tt/db/testing'
import { ensureStream, LOGISTICS_STREAM } from '@tt/messaging'
import { startNats, streamMessages, type TestNats } from '@tt/messaging/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertOutboxEvent } from '../db/outbox.js'
import { buildShipmentRegisteredEvent } from '../domain/shipment.js'
import { countingJetStream, outboxRows, quietLog, startTestDatabase, type TestDatabase } from '../test-support.js'
import { publishOutboxBatch, startOutboxRelay } from './relay.js'

let db: TestDatabase
let nats: TestNats

beforeAll(async () => {
  ;[db, nats] = await Promise.all([startTestDatabase({ restartable: true }), startNats()])
})

afterAll(async () => {
  await Promise.all([db?.stop(), nats?.stop()])
})

beforeEach(async () => {
  await db.postgres.startServer()
  await db.pool.query('DELETE FROM outbox')
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
  await ensureStream(nats.jsm)
})

async function addEvent(): Promise<string> {
  const event = buildShipmentRegisteredEvent({
    shipmentId: randomUUID(),
    orderReference: 'ORD-1',
    trackingNumber: 'PF-0000000001',
    originFacilityId: 'PRG-HUB-01',
    destination: 'Brno',
    recipientId: 'cust-1',
    expectedDeliveryAt: new Date('2026-11-11T16:00:00Z'),
    registeredAt: new Date(),
    registeredEventId: randomUUID(),
  })
  await insertOutboxEvent(db.pool, event)
  return event.eventId
}

async function isPublished(): Promise<boolean> {
  return (await outboxRows(db.pool)).every((row) => row.published_at !== null)
}

/** The real client, but the first publish stops Postgres: the transaction of the batch is open then. */
function stoppingPostgres(mode: 'fast' | 'kill'): JetStreamClient {
  let stopped = false
  return countingJetStream(nats.js, {
    async before() {
      if (stopped) return
      stopped = true
      await db.postgres.stopServer(mode)
      await sleep(200)
    },
  }).js
}

describe.each(['fast', 'kill'] as const)('outbox relay when Postgres stops (%s) during a batch', (mode) => {
  it('rejects while it waits for the NATS ack and succeeds after the restart', async () => {
    const id = await addEvent()
    let failure: unknown
    const uncaught = await uncaughtErrorsDuring(async () => {
      failure = await publishOutboxBatch(db.pool, stoppingPostgres(mode), 10).catch((err: unknown) => err)
    })

    expect(uncaught).toEqual([])
    // The database error as it is: the relay only logs it.
    expect(failure).toMatchObject({ message: 'Client has encountered a connection error and is not queryable' })
    expect([db.pool.totalCount, db.pool.idleCount]).toEqual([0, 0])

    await db.postgres.startServer()

    expect(await isPublished()).toBe(false)
    expect(await publishOutboxBatch(db.pool, nats.js, 10)).toBe(1)
    expect(await isPublished()).toBe(true)
    // Published in both batches, but the stream kept one copy (msgID = eventId).
    expect((await streamMessages(nats.jsm)).map((message) => message.msgId)).toEqual([id])
  })

  it('rejects while it waits for the database', async () => {
    const id = await addEvent()
    const blocker = await db.owner.connect()
    blocker.on('error', () => {})
    let failure: unknown
    const uncaught = await uncaughtErrorsDuring(async () => {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE outbox IN ACCESS EXCLUSIVE MODE')
      const running = publishOutboxBatch(db.pool, nats.js, 10).catch((err: unknown) => err)
      await vi.waitFor(async () => {
        const { rows } = await db.owner.query("SELECT 1 FROM pg_locks WHERE NOT granted AND relation = 'outbox'::regclass")
        expect(rows).toHaveLength(1)
      })
      await db.postgres.stopServer(mode)
      failure = await running
      await sleep(200)
    })
    blocker.release(true)

    expect(uncaught).toEqual([])
    expect(failure).toBeInstanceOf(Error)
    expect(await streamMessages(nats.jsm)).toEqual([])
    expect([db.pool.totalCount, db.pool.idleCount]).toEqual([0, 0])

    await db.postgres.startServer()

    expect(await publishOutboxBatch(db.pool, nats.js, 10)).toBe(1)
    expect((await streamMessages(nats.jsm)).map((message) => message.msgId)).toEqual([id])
  })

  it('keeps running and publishes the event once Postgres is back', async () => {
    const id = await addEvent()
    const warn = vi.fn()
    const uncaught = await uncaughtErrorsDuring(async () => {
      const relay = startOutboxRelay({
        pool: db.pool,
        js: stoppingPostgres(mode),
        intervalMs: 20,
        maxBackoffMs: 200,
        log: { ...quietLog, warn },
      })
      try {
        // Also rounds that cannot connect at all.
        await vi.waitFor(() => expect(warn.mock.calls.length).toBeGreaterThan(2), { timeout: 5_000 })
        await db.postgres.startServer()
        await vi.waitFor(async () => expect(await isPublished()).toBe(true), { timeout: 10_000, interval: 50 })
      } finally {
        await relay.stop()
      }
    })

    expect(uncaught).toEqual([])
    expect((await streamMessages(nats.jsm)).map((message) => message.msgId)).toEqual([id])
  })
})
