import { randomUUID } from 'node:crypto'
import type { JetStreamClient } from '@nats-io/jetstream'
import { ensureStream, LOGISTICS_STREAM } from '@tt/messaging'
import { startNats, type TestNats } from '@tt/messaging/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertOutboxEvent } from '../db/outbox.js'
import { buildShipmentRegisteredEvent } from '../domain/shipment.js'
import {
  countingJetStream,
  outboxRows,
  quietLog,
  startTestDatabase,
  streamMessages,
  type TestDatabase,
} from '../test-support.js'
import { publishOutboxBatch, startOutboxRelay, type OutboxRelay } from './relay.js'

let db: TestDatabase
let nats: TestNats
const relays: OutboxRelay[] = []

beforeAll(async () => {
  ;[db, nats] = await Promise.all([startTestDatabase(), startNats()])
})

afterAll(async () => {
  await Promise.all([db?.stop(), nats?.stop()])
})

beforeEach(async () => {
  await db.pool.query('DELETE FROM outbox')
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
  await ensureStream(nats.jsm)
})

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()))
})

function relay(js: JetStreamClient, options: { batchSize?: number; intervalMs?: number } = {}) {
  const started = startOutboxRelay({
    pool: db.pool,
    js,
    intervalMs: options.intervalMs ?? 20,
    batchSize: options.batchSize ?? 5,
    maxBackoffMs: 200,
    log: quietLog,
  })
  relays.push(started)
  return started
}

/** Writes `count` outbox rows, one transaction each (distinct created_at), and returns their eventIds. */
async function addEvents(count: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const event = buildShipmentRegisteredEvent({
      shipmentId: randomUUID(),
      orderReference: `ORD-${i}`,
      trackingNumber: `PF-${String(i).padStart(10, '0')}`,
      originFacilityId: 'PRG-HUB-01',
      destination: 'Brno',
      recipientId: 'cust-1',
      expectedDeliveryAt: new Date('2026-11-11T16:00:00Z'),
      registeredAt: new Date(),
      registeredEventId: randomUUID(),
    })
    await insertOutboxEvent(db.pool, event)
    ids.push(event.eventId)
  }
  return ids
}

async function publishedIds(): Promise<string[]> {
  return (await outboxRows(db.pool)).filter((row) => row.published_at !== null).map((row) => row.event_id)
}

describe('outbox relay', () => {
  it('two relays on the same table publish every event exactly once', async () => {
    const ids = await addEvents(40)
    // Slow publishes make the two relays' rounds overlap.
    const counter = countingJetStream(nats.js, { delayMs: 10 })

    relay(counter.js)
    relay(counter.js)

    await vi.waitFor(async () => expect(await publishedIds()).toHaveLength(40), { timeout: 15_000, interval: 50 })

    expect([...counter.counts.keys()].sort()).toEqual([...ids].sort())
    expect([...counter.counts.values()].every((n) => n === 1)).toBe(true)
    const messages = await streamMessages(nats.jsm)
    expect(messages.map((m) => m.msgId).sort()).toEqual([...ids].sort())
  })

  it('a relay waiting for NATS does not block another relay (SKIP LOCKED)', async () => {
    const ids = await addEvents(10)
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    // The first relay locks the three oldest rows and then hangs on its first publish.
    const stuck = countingJetStream(nats.js, { before: () => released })
    relay(stuck.js, { batchSize: 3 })
    try {
      await vi.waitFor(() => expect(stuck.counts.size).toBe(1))

      relay(nats.js, { batchSize: 3 })

      // The second relay publishes everything that is not locked by the first one.
      await vi.waitFor(async () => expect(await publishedIds()).toHaveLength(7), { timeout: 5_000, interval: 50 })
      expect(new Set(await publishedIds())).toEqual(new Set(ids.slice(3)))
    } finally {
      // Always unblock the first relay, so afterEach can stop it.
      release()
    }
    await vi.waitFor(async () => expect(await publishedIds()).toHaveLength(10), { timeout: 5_000, interval: 50 })
  })

  it('rolls back the whole batch when a publish fails, then retries it', async () => {
    const ids = await addEvents(3)
    let failures = 0
    // The second event fails twice: the first one must not be marked as published either.
    const flaky = countingJetStream(nats.js, {
      async before(msgID) {
        if (msgID === ids[1] && failures < 2) {
          failures += 1
          throw new Error('NATS unavailable')
        }
      },
    })

    await expect(publishOutboxBatch(db.pool, flaky.js, 10)).rejects.toThrow('NATS unavailable')
    expect(await publishedIds()).toEqual([])

    relay(flaky.js)
    await vi.waitFor(async () => expect(await publishedIds()).toHaveLength(3), { timeout: 5_000, interval: 50 })
    expect(failures).toBe(2)
    // The first event was published in each round, but the stream kept one copy (msgID = eventId).
    expect(flaky.counts.get(ids[0]!)).toBe(3)
    const messages = await streamMessages(nats.jsm)
    expect(messages.map((m) => m.msgId)).toEqual(ids)
  })

  it('publishes each row to the subject stored in the outbox row', async () => {
    const [id] = await addEvents(1)
    // A subject that differs from subjectForEvent, as if the subject rules had changed since the row was written.
    const stored = 'logistics.shipment.registered.legacy'
    await db.pool.query('UPDATE outbox SET subject = $1 WHERE event_id = $2', [stored, id])

    await expect(publishOutboxBatch(db.pool, nats.js, 10)).resolves.toBe(1)

    const messages = await streamMessages(nats.jsm)
    expect(messages.map((m) => ({ subject: m.subject, msgId: m.msgId }))).toEqual([{ subject: stored, msgId: id }])
  })

  it('stop() lets the current round finish', async () => {
    await addEvents(1)
    let publishing!: () => void
    const started = new Promise<void>((resolve) => {
      publishing = resolve
    })
    const slow = countingJetStream(nats.js, {
      async before() {
        publishing()
        await new Promise((resolve) => setTimeout(resolve, 300))
      },
    })
    const running = relay(slow.js)
    await started

    await running.stop()

    expect(await publishedIds()).toHaveLength(1)
  })
})
