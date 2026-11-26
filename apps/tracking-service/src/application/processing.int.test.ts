import { jetstream } from '@nats-io/jetstream'
import type { LogisticsEvent } from '@tt/contracts'
import {
  consumeEvents,
  LOGISTICS_STREAM,
  setupNats,
  type ConsumeHandle,
  type EventHandler,
  type MessageMetadata,
} from '@tt/messaging'
import { startNats, streamMessages, type TestNats } from '@tt/messaging/testing'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { project } from '../domain/projection.js'
import type { TrackingEvent } from '../domain/shipment-status.js'
import { parcel, registered, SHIPMENT_ID } from '../test-events.js'
import { permutations } from '../test-permutations.js'
import {
  clearTables,
  expectedReadModel,
  memoryLog,
  publish,
  quarantinedEvents,
  readModel,
  receivedMessages,
  startTestDatabase,
  TEST_TIMING,
  trackingConflicts,
  waitUntilAcked,
  type TestDatabase,
} from '../test-support.js'
import { isTransient } from '../consumer.js'
import { createEventHandler } from './handle-event.js'
import { createProcessEvent } from './process-event.js'
import { createQuarantine } from './quarantine.js'

const TRACKING_NUMBER = 'PF-4821093375'
const OTHER_SHIPMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

let db: TestDatabase
let nats: TestNats
let handles: ConsumeHandle[] = []
let logged: ReturnType<typeof memoryLog>

beforeAll(async () => {
  ;[db, nats] = await Promise.all([startTestDatabase(), startNats()])
})

afterAll(async () => {
  await Promise.all([db?.stop(), nats?.stop()])
})

beforeEach(async () => {
  await clearTables(db.owner)
  // Deleting the stream also deletes its consumers; sequences start at 1 again.
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
  await setupNats(nats.jsm)
  logged = memoryLog()
})

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()))
  vi.restoreAllMocks()
})

/** The handler as main.ts builds it. */
function trackingHandler(pool: pg.Pool = db.pool): EventHandler {
  return createEventHandler({ processEvent: createProcessEvent({ pool }), log: logged.log })
}

/**
 * Starts the "tracking" consumer as main.ts does, with short delays. Its own
 * log lines (retries, naks) go to a logger of their own, so `logged` has only
 * the result lines of the handler.
 */
async function startConsuming(handler: EventHandler = trackingHandler()): Promise<ConsumeHandle> {
  const handle = await consumeEvents(jetstream(nats.nc), 'tracking', {
    handler,
    isTransient,
    quarantine: createQuarantine({ pool: db.pool }),
    log: memoryLog().log,
    timing: TEST_TIMING,
  })
  handles.push(handle)
  return handle
}

async function processAll(...events: LogisticsEvent[]): Promise<void> {
  if (handles.length === 0) await startConsuming()
  await publish(nats, ...events)
  await waitUntilAcked(nats)
}

const results = () => logged.lines.map((line) => line.result)

function journey() {
  return {
    registration: registered('2026-10-28T08:00:00Z'),
    accepted: parcel('parcel.accepted', '2026-10-28T08:15:00Z', { facilityId: 'DEPOT-PRAHA' }),
    atHub: parcel('parcel.arrived_at_hub', '2026-10-28T09:30:00Z', { receivedAt: '2026-10-28T09:31:12.345Z' }),
    outForDelivery: parcel('parcel.out_for_delivery', '2026-10-28T12:00:00Z'),
    delivered: parcel('parcel.delivered', '2026-10-28T14:00:00Z'),
  }
}

async function updatedAt(): Promise<Date> {
  const { rows } = await db.pool.query('SELECT updated_at FROM shipment_tracking WHERE shipment_id = $1', [SHIPMENT_ID])
  return rows[0]?.updated_at
}

describe('normal processing', () => {
  it('stores the state and the history that project() returns', async () => {
    const { registration, accepted, atHub } = journey()
    const events: TrackingEvent[] = [registration, accepted, atHub]
    const before = Date.now()

    await processAll(...events)

    const model = await readModel(db.pool, SHIPMENT_ID)
    expect(model).toEqual(expectedReadModel(TRACKING_NUMBER, project(events)))
    // Guards against a projection that is wrong in both places.
    expect(model?.state).toEqual({
      tracking_number: TRACKING_NUMBER,
      status: 'AT_HUB',
      last_location: 'DEPOT-BRNO',
      last_event_at: new Date('2026-10-28T09:30:00Z'),
      delivered_at: null,
    })
    expect(model?.history.map((row) => row.event_type)).toEqual(events.map((event) => event.eventType))
    // Processing time, not business time.
    expect((await updatedAt()).getTime()).toBeGreaterThan(before - 60_000)
    expect(results()).toEqual(['processed', 'processed', 'processed'])
  })

  it('stores the message with the whole event as payload and its fields in the columns', async () => {
    const { atHub } = journey()

    await processAll(atHub)

    expect(await receivedMessages(db.pool)).toEqual([
      {
        event_id: atHub.eventId,
        shipment_id: SHIPMENT_ID,
        event_type: 'parcel.arrived_at_hub',
        occurred_at: new Date(atHub.occurredAt),
        received_at: new Date(atHub.receivedAt),
        payload: atHub,
        subject: 'logistics.parcel.arrived_at_hub.v1',
        stream_sequence: '1',
      },
    ])
  })

  it('stores an anomaly after the delivery in the history and keeps the state', async () => {
    const { registration, delivered } = journey()
    const late = parcel('parcel.arrived_at_hub', '2026-10-29T08:15:00Z', { facilityId: 'DEPOT-OSTRAVA' })

    await processAll(registration, delivered, late)

    const model = await readModel(db.pool, SHIPMENT_ID)
    expect(model).toEqual(expectedReadModel(TRACKING_NUMBER, project([registration, delivered, late])))
    expect(model?.state.status).toBe('DELIVERED')
    expect(model?.history.map((row) => row.is_anomaly)).toEqual([false, false, true])
  })

  it('keeps shipments apart', async () => {
    const { registration, atHub } = journey()
    const other = registered('2026-10-28T08:05:00Z', { shipmentId: OTHER_SHIPMENT_ID })

    await processAll(registration, other, atHub)

    expect((await readModel(db.pool, SHIPMENT_ID))?.history).toHaveLength(2)
    expect(await readModel(db.pool, OTHER_SHIPMENT_ID)).toEqual(expectedReadModel(TRACKING_NUMBER, project([other])))
  })

  it('writes one structured log line per message (assignment 15.1)', async () => {
    const { registration } = journey()

    await processAll(registration)

    expect(logged.lines).toHaveLength(1)
    expect(logged.lines[0]).toMatchObject({
      service: 'tracking',
      eventId: registration.eventId,
      eventType: 'shipment.registered',
      shipmentId: SHIPMENT_ID,
      correlationId: SHIPMENT_ID,
      streamSequence: 1,
      result: 'processed',
    })
  })
})

describe('AC-03: out of order', () => {
  it('ends as DELIVERED with the history in R2 order when delivered arrives before arrived_at_hub', async () => {
    const { registration, accepted, atHub, delivered } = journey()

    await processAll(registration, accepted, delivered, atHub)

    const model = await readModel(db.pool, SHIPMENT_ID)
    expect(model).toEqual(expectedReadModel(TRACKING_NUMBER, project([registration, accepted, atHub, delivered])))
    expect(model?.state).toMatchObject({ status: 'DELIVERED', delivered_at: new Date(delivered.occurredAt) })
    expect(model?.history.map((row) => row.event_id)).toEqual([
      registration.eventId,
      accepted.eventId,
      atHub.eventId,
      delivered.eventId,
    ])
    expect(model?.history.map((row) => row.is_anomaly)).toEqual([false, false, false, false])
  })
})

describe('AC-02: duplicates', () => {
  it('counts once, with the earlier receivedAt, when the later-received copy is published first', async () => {
    const { registration, atHub } = journey()
    // As strings the later receivedAt sorts first, so it must be compared as a timestamp.
    const later = { ...atHub, receivedAt: '2026-10-28T09:31:12.500Z' }
    // The same instant written differently is not a conflict.
    const earlier = { ...atHub, occurredAt: '2026-10-28T09:30:00.000Z', receivedAt: '2026-10-28T09:31:12Z' }

    await processAll(registration, later, earlier)

    expect(results()).toEqual(['processed', 'processed', 'duplicate'])
    const model = await readModel(db.pool, SHIPMENT_ID)
    expect(model).toEqual(expectedReadModel(TRACKING_NUMBER, project([registration, earlier])))
    expect(model?.history.map((row) => row.received_at)).toEqual([
      new Date(registration.receivedAt),
      new Date(earlier.receivedAt),
    ])
    // Both messages are stored as they came.
    expect((await receivedMessages(db.pool)).map((row) => row.payload)).toEqual([registration, later, earlier])
    expect(await trackingConflicts(db.pool)).toEqual([])
  })

  it('keeps the earlier receivedAt when the later-received copy is published second', async () => {
    const { registration, atHub } = journey()
    const later = { ...atHub, receivedAt: '2026-10-28T10:00:00Z' }
    await processAll(registration, atHub)
    const before = await readModel(db.pool, SHIPMENT_ID)
    const updatedBefore = await updatedAt()

    await processAll(later)

    expect(results()).toEqual(['processed', 'processed', 'duplicate'])
    expect(await readModel(db.pool, SHIPMENT_ID)).toEqual(before)
    // Processing time: every processed message of the shipment counts (docs/tracking-api.md).
    expect((await updatedAt()).getTime()).toBeGreaterThan(updatedBefore.getTime())
  })
})

describe('failure between write and ACK', () => {
  /** Real processing, but the first delivery fails after the commit, before the ack (as in a crash). */
  function failingAfterCommit(deliveries: MessageMetadata[]): EventHandler {
    const handler = trackingHandler()
    return async (event, metadata) => {
      await handler(event, metadata)
      deliveries.push(metadata)
      if (metadata.deliveryCount === 1) throw new Error('crash after commit, before ack')
    }
  }

  it('counts nothing twice when a committed message is delivered again', async () => {
    const { registration, accepted, delivered } = journey()
    const deliveries: MessageMetadata[] = []
    await startConsuming(failingAfterCommit(deliveries))

    await processAll(registration)
    await processAll(accepted)
    await processAll(delivered)

    // Every message was processed twice, with the same stream sequence.
    expect(deliveries.map((d) => [d.streamSequence, d.deliveryCount])).toEqual([
      [1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2],
    ])
    expect(results()).toEqual(['processed', 'duplicate', 'processed', 'duplicate', 'processed', 'duplicate'])
    // The second delivery added no row.
    expect((await receivedMessages(db.pool)).map((row) => [row.stream_sequence, row.event_id])).toEqual([
      ['1', registration.eventId],
      ['2', accepted.eventId],
      ['3', delivered.eventId],
    ])
    expect(await readModel(db.pool, SHIPMENT_ID)).toEqual(
      expectedReadModel(TRACKING_NUMBER, project([registration, accepted, delivered])),
    )
    expect(await trackingConflicts(db.pool)).toEqual([])
  })

  /** A pool whose first transaction fails at COMMIT: nothing is committed. */
  function failingFirstCommit(pool: pg.Pool): pg.Pool {
    let failed = false
    return new Proxy(pool, {
      get(target, prop) {
        if (prop !== 'connect') return Reflect.get(target, prop)
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(clientTarget, clientProp) {
              const value = Reflect.get(clientTarget, clientProp)
              if (clientProp === 'query') {
                return (...args: [string]) => {
                  if (args[0] === 'COMMIT' && !failed) {
                    failed = true
                    return Promise.reject(new Error('connection lost before commit'))
                  }
                  return clientTarget.query(...args)
                }
              }
              return typeof value === 'function' ? value.bind(clientTarget) : value
            },
          })
        }
      },
    })
  }

  it('does not ack before the commit: a message whose commit failed is delivered again and processed', async () => {
    const { registration } = journey()
    await startConsuming(trackingHandler(failingFirstCommit(db.pool)))

    await publish(nats, registration)
    await vi.waitFor(async () => expect(await receivedMessages(db.pool)).toHaveLength(1), { timeout: 10_000 })
    await waitUntilAcked(nats)

    // One result only: the first delivery was rolled back as a whole.
    expect(results()).toEqual(['processed'])
    const info = await nats.jsm.consumers.info(LOGISTICS_STREAM.name, 'tracking')
    expect(info.delivered.consumer_seq).toBe(2)
    expect(await readModel(db.pool, SHIPMENT_ID)).toEqual(
      expectedReadModel(TRACKING_NUMBER, project([registration])),
    )
  })

  it('writes everything or nothing: no message is stored if the read model cannot be written', async () => {
    const { registration, accepted } = journey()
    await processAll(registration)
    const before = await readModel(db.pool, SHIPMENT_ID)
    const process = createProcessEvent({ pool: db.pool })
    const metadata = { streamSequence: 2, subject: 'logistics.parcel.accepted.v1', deliveryCount: 1 }

    await db.owner.query('REVOKE INSERT ON tracking_history FROM tracking_service')
    try {
      await expect(process(accepted, metadata)).rejects.toMatchObject({ code: '42501' })
    } finally {
      await db.owner.query('GRANT INSERT ON tracking_history TO tracking_service')
    }

    expect(await receivedMessages(db.pool)).toHaveLength(1)
    expect(await readModel(db.pool, SHIPMENT_ID)).toEqual(before)
  })
})

describe('AC-12: conflicts', () => {
  it('lists a copy with a different facilityId and does not change the projection', async () => {
    const { registration, atHub } = journey()
    const conflicting = { ...atHub, receivedAt: '2026-10-28T10:00:00Z', data: { ...atHub.data, facilityId: 'DEPOT-OSTRAVA' } }
    await processAll(registration, atHub)
    const before = await readModel(db.pool, SHIPMENT_ID)

    await processAll(conflicting)

    expect(results()).toEqual(['processed', 'processed', 'conflict'])
    expect(await trackingConflicts(db.pool)).toEqual([
      {
        shipment_id: SHIPMENT_ID,
        event_id: atHub.eventId,
        // bigint is read as a string.
        stream_sequence: '3',
        received_at: new Date(conflicting.receivedAt),
        differing_fields: ['data.facilityId'],
      },
    ])
    expect(await readModel(db.pool, SHIPMENT_ID)).toEqual(before)
    // The conflicting copy is stored like any other message; the quarantine is for invalid ones.
    expect((await receivedMessages(db.pool)).at(-1)).toMatchObject({ stream_sequence: '3', payload: conflicting })
    expect(await quarantinedEvents(db.pool)).toEqual([])
  })

  it('does not take anything from a conflicting copy with an earlier receivedAt', async () => {
    const { registration, atHub } = journey()
    const conflicting = {
      ...atHub,
      receivedAt: '2026-10-28T09:30:01Z',
      data: { ...atHub.data, facilityId: 'DEPOT-OSTRAVA' },
    }

    await processAll(registration, atHub, conflicting)

    expect(await readModel(db.pool, SHIPMENT_ID)).toEqual(
      expectedReadModel(TRACKING_NUMBER, project([registration, atHub])),
    )
  })

  it('adds no row when the same conflicting message is delivered again, and acks it', async () => {
    const { registration, atHub } = journey()
    const conflicting = { ...atHub, data: { ...atHub.data, facilityId: 'DEPOT-OSTRAVA' } }
    const handler = trackingHandler()
    await startConsuming(async (event, metadata) => {
      await handler(event, metadata)
      if (metadata.streamSequence === 3 && metadata.deliveryCount === 1) throw new Error('crash before ack')
    })

    await processAll(registration, atHub, conflicting)

    expect(results()).toEqual(['processed', 'processed', 'conflict', 'conflict'])
    expect(logged.lines.map((line) => line.streamSequence)).toEqual([1, 2, 3, 3])
    expect(await receivedMessages(db.pool)).toHaveLength(3)
    expect(await trackingConflicts(db.pool)).toHaveLength(1)
  })

  it('lists every conflicting copy sent by a producer', async () => {
    const { registration, atHub } = journey()
    const conflicting = { ...atHub, data: { ...atHub.data, facilityId: 'DEPOT-OSTRAVA' } }

    await processAll(registration, atHub, conflicting, conflicting)

    expect((await trackingConflicts(db.pool)).map((row) => row.stream_sequence)).toEqual(['3', '4'])
  })

  it('lists a copy with a different shipmentId under both shipments and changes neither projection', async () => {
    const { registration, atHub } = journey()
    const other = registered('2026-10-28T08:05:00Z', { shipmentId: OTHER_SHIPMENT_ID })
    await processAll(registration, other, atHub)
    const before = [await readModel(db.pool, SHIPMENT_ID), await readModel(db.pool, OTHER_SHIPMENT_ID)]
    const conflicting = { ...atHub, shipmentId: OTHER_SHIPMENT_ID, correlationId: OTHER_SHIPMENT_ID }

    await processAll(conflicting)

    const conflict = {
      event_id: atHub.eventId,
      stream_sequence: '4',
      received_at: new Date(conflicting.receivedAt),
      differing_fields: ['correlationId', 'shipmentId'],
    }
    expect(await trackingConflicts(db.pool)).toEqual([
      { shipment_id: SHIPMENT_ID, ...conflict },
      { shipment_id: OTHER_SHIPMENT_ID, ...conflict },
    ])
    expect([await readModel(db.pool, SHIPMENT_ID), await readModel(db.pool, OTHER_SHIPMENT_ID)]).toEqual(before)
    // The kept copy has the shipmentId of its own shipment; the log line that of the new message.
    expect((await receivedMessages(db.pool)).filter((row) => row.event_id === atHub.eventId)).toMatchObject([
      { stream_sequence: '3', shipment_id: SHIPMENT_ID },
      { stream_sequence: '4', shipment_id: OTHER_SHIPMENT_ID },
    ])
    expect(logged.lines.at(-1)).toMatchObject({ shipmentId: OTHER_SHIPMENT_ID, result: 'conflict' })
  })

  it('lists a conflict between shipments under the other shipment once that one is registered', async () => {
    const { registration, atHub } = journey()
    const conflicting = { ...atHub, shipmentId: OTHER_SHIPMENT_ID, correlationId: OTHER_SHIPMENT_ID }
    await processAll(registration, atHub, conflicting)
    expect((await trackingConflicts(db.pool)).map((row) => row.shipment_id)).toEqual([SHIPMENT_ID])

    await processAll(registered('2026-10-28T08:05:00Z', { shipmentId: OTHER_SHIPMENT_ID }))

    expect((await trackingConflicts(db.pool)).map((row) => row.shipment_id)).toEqual([SHIPMENT_ID, OTHER_SHIPMENT_ID])
    expect((await readModel(db.pool, OTHER_SHIPMENT_ID))?.history).toHaveLength(1)
  })
})

describe('conflicts processed out of stream order', () => {
  /** Everything stored for both shipments, except updated_at (processing time). */
  async function snapshot() {
    return {
      messages: await receivedMessages(db.pool),
      conflicts: await trackingConflicts(db.pool),
      readModels: [await readModel(db.pool, SHIPMENT_ID), await readModel(db.pool, OTHER_SHIPMENT_ID)],
    }
  }

  /** Empties tracking_db and processes the same stream again from its start. */
  async function replay() {
    await Promise.all(handles.splice(0).map((handle) => handle.stop()))
    await clearTables(db.owner)
    await nats.jsm.consumers.delete(LOGISTICS_STREAM.name, 'tracking')
    await setupNats(nats.jsm)
    logged.lines.length = 0
    await startConsuming()
    await waitUntilAcked(nats)
  }

  const sequences = () => logged.lines.map((line) => line.streamSequence)

  /**
   * The real handler, but the first delivery of these messages fails with a
   * permanent error before anything is written. The message is naked with a
   * delay, so the next message is processed before its redelivery.
   */
  function failingFirstDelivery(...failing: number[]): EventHandler {
    const handler = trackingHandler()
    return async (event, metadata) => {
      if (failing.includes(metadata.streamSequence) && metadata.deliveryCount === 1) {
        throw new Error('processing failed')
      }
      await handler(event, metadata)
    }
  }

  it('keeps the copy with the lower stream sequence when it is redelivered after a different copy', async () => {
    const { registration, atHub } = journey()
    const second = { ...atHub, receivedAt: '2026-10-28T10:00:00Z', data: { ...atHub.data, facilityId: 'DEPOT-OSTRAVA' } }
    await publish(nats, registration, atHub, second)

    await startConsuming(failingFirstDelivery(2))
    await waitUntilAcked(nats)

    // The second copy was processed first and counted until the first one was redelivered.
    expect(sequences()).toEqual([1, 3, 2])
    expect(results()).toEqual(['processed', 'processed', 'conflict'])
    const result = await snapshot()
    expect(result.conflicts).toEqual([
      {
        shipment_id: SHIPMENT_ID,
        event_id: atHub.eventId,
        stream_sequence: '3',
        received_at: new Date(second.receivedAt),
        differing_fields: ['data.facilityId'],
      },
    ])
    expect(result.readModels[0]).toEqual(expectedReadModel(TRACKING_NUMBER, project([registration, atHub])))

    await replay()

    expect(sequences()).toEqual([1, 2, 3])
    expect(await snapshot()).toEqual(result)
  })

  it('moves the event and a replaced registration between shipments, as a replay does', async () => {
    // Two different registrations with one eventId: the first one is for the other shipment.
    const second = registered('2026-10-28T08:00:00Z')
    const first = registered('2026-10-28T08:00:00Z', { eventId: second.eventId, shipmentId: OTHER_SHIPMENT_ID })
    const { atHub } = journey()
    await publish(nats, first, second, atHub)

    await startConsuming(failingFirstDelivery(1))
    await waitUntilAcked(nats)

    // Until the redelivery SHIPMENT_ID was known; its registration is now a conflict.
    expect(sequences().at(-1)).toBe(1)
    expect(results()).toContain('processed')
    const result = await snapshot()
    expect(result.readModels).toEqual([null, expectedReadModel(TRACKING_NUMBER, project([first]))])
    // Listed under the known shipment only.
    expect(result.conflicts).toMatchObject([
      { shipment_id: OTHER_SHIPMENT_ID, stream_sequence: '2', differing_fields: ['correlationId', 'shipmentId'] },
    ])

    await replay()

    expect(await snapshot()).toEqual(result)
  })

  it('changes nothing when the copies are delivered again', async () => {
    const { registration, atHub } = journey()
    const second = { ...atHub, data: { ...atHub.data, facilityId: 'DEPOT-OSTRAVA' } }
    const process = createProcessEvent({ pool: db.pool })
    const at = (streamSequence: number) => ({ streamSequence, subject: 'logistics.parcel.arrived_at_hub.v1', deliveryCount: 1 })
    await process(registration, { ...at(1), subject: 'logistics.shipment.registered.v1' })
    await process(second, at(3))
    await process(atHub, at(2))
    const result = await snapshot()

    expect(await process(second, at(3))).toBe('conflict')
    expect(await process(atHub, at(2))).toBe('duplicate')

    expect(await snapshot()).toEqual(result)
  })

  it('gives the result of stream order for every processing order', async () => {
    const { atHub } = journey()
    const registrations = [
      registered('2026-10-28T08:00:00Z'),
      registered('2026-10-28T08:05:00Z', { shipmentId: OTHER_SHIPMENT_ID }),
    ]
    // Copies of one event in stream order: the first, a different one of another shipment and
    // its retry (two conflicts), a retry of the first that was received earlier (R1), and one
    // more different copy.
    const copies: TrackingEvent[] = [
      atHub,
      { ...atHub, shipmentId: OTHER_SHIPMENT_ID, correlationId: OTHER_SHIPMENT_ID },
      { ...atHub, shipmentId: OTHER_SHIPMENT_ID, correlationId: OTHER_SHIPMENT_ID, receivedAt: '2026-10-28T09:30:10Z' },
      { ...atHub, receivedAt: '2026-10-28T09:30:30Z' },
      { ...atHub, data: { ...atHub.data, scannerId: 'SCANNER-99' } },
    ]
    const messages = copies.map((event, index) => ({ event, streamSequence: index + 3 }))
    const process = createProcessEvent({ pool: db.pool })

    async function resultOf(order: typeof messages) {
      await clearTables(db.owner)
      for (const [index, event] of registrations.entries()) {
        await process(event, { streamSequence: index + 1, subject: 'logistics.shipment.registered.v1', deliveryCount: 1 })
      }
      for (const { event, streamSequence } of order) {
        // A subject per message shows that the subject stays with its sequence.
        await process(event, { streamSequence, subject: `logistics.parcel.test-${streamSequence}`, deliveryCount: 1 })
      }
      return snapshot()
    }

    const inStreamOrder = await resultOf(messages)
    expect(inStreamOrder.readModels).toEqual([
      expectedReadModel(TRACKING_NUMBER, project([registrations[0]!, copies[3]!])),
      expectedReadModel(TRACKING_NUMBER, project([registrations[1]!])),
    ])
    expect(inStreamOrder.conflicts.map((row) => [row.stream_sequence, row.shipment_id, row.differing_fields])).toEqual([
      ['4', SHIPMENT_ID, ['correlationId', 'shipmentId']],
      ['4', OTHER_SHIPMENT_ID, ['correlationId', 'shipmentId']],
      ['5', SHIPMENT_ID, ['correlationId', 'shipmentId']],
      ['5', OTHER_SHIPMENT_ID, ['correlationId', 'shipmentId']],
      ['7', SHIPMENT_ID, ['data.scannerId']],
    ])

    const orders = permutations(messages)
    expect(orders).toHaveLength(120)
    for (const order of orders) {
      expect(await resultOf(order), `order ${order.map((m) => m.streamSequence)}`).toEqual(inStreamOrder)
    }
  }, 60_000)

  it('rejects a new message whose stream sequence is already stored (the stream was reset alone)', async () => {
    const { registration, atHub } = journey()
    const process = createProcessEvent({ pool: db.pool })
    const metadata = { streamSequence: 1, subject: 'logistics.shipment.registered.v1', deliveryCount: 1 }
    await process(registration, metadata)
    const before = await snapshot()

    await expect(process(atHub, metadata)).rejects.toThrow('must be reset together')
    expect(await snapshot()).toEqual(before)

    // Also if the event itself is already known from another message.
    await process(atHub, { ...metadata, streamSequence: 2 })
    const withScan = await snapshot()
    await expect(process(atHub, metadata)).rejects.toThrow('must be reset together')
    expect(await snapshot()).toEqual(withScan)
  })
})

describe('AC-11: scan before the registration', () => {
  it('stores no tracking until the registration arrives, then everything including the early scans', async () => {
    const { registration, accepted, atHub } = journey()

    await processAll(atHub, accepted)

    expect(results()).toEqual(['waiting_for_registration', 'waiting_for_registration'])
    expect(await readModel(db.pool, SHIPMENT_ID)).toBeNull()
    expect(await receivedMessages(db.pool)).toHaveLength(2)

    await processAll(registration)

    expect(results().at(-1)).toBe('processed')
    const model = await readModel(db.pool, SHIPMENT_ID)
    expect(model).toEqual(expectedReadModel(TRACKING_NUMBER, project([registration, accepted, atHub])))
    expect(model?.state.status).toBe('AT_HUB')
    expect(model?.history).toHaveLength(3)
  })

  it('reports a duplicate and a conflict also while the shipment is not known', async () => {
    const { atHub } = journey()
    const conflicting = { ...atHub, data: { ...atHub.data, scannerId: 'SCANNER-99' } }

    await processAll(atHub, atHub, conflicting)

    expect(results()).toEqual(['waiting_for_registration', 'duplicate', 'conflict'])
    expect(await readModel(db.pool, SHIPMENT_ID)).toBeNull()
  })
})

describe('AC-04: restart', () => {
  it('processes the events published while it was not consuming', async () => {
    const { registration, accepted, outForDelivery, delivered } = journey()
    const first = await startConsuming()
    await processAll(registration, accepted)
    await first.stop()

    await publish(nats, outForDelivery, delivered)
    expect(await receivedMessages(db.pool)).toHaveLength(2)

    await startConsuming()
    await waitUntilAcked(nats)

    expect(await readModel(db.pool, SHIPMENT_ID)).toEqual(
      expectedReadModel(TRACKING_NUMBER, project([registration, accepted, outForDelivery, delivered])),
    )
    // Nothing from before the restart was processed again.
    expect(results()).toEqual(['processed', 'processed', 'processed', 'processed'])
    expect(await streamMessages(nats.jsm)).toHaveLength(4)
  })

  it('stop() lets the message in progress finish and be acked', async () => {
    const { registration } = journey()
    const blocker = await db.owner.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE received_messages IN ACCESS EXCLUSIVE MODE')
      const handle = await startConsuming()
      await publish(nats, registration)
      await vi.waitFor(async () => {
        const info = await nats.jsm.consumers.info(LOGISTICS_STREAM.name, 'tracking')
        expect(info.num_ack_pending).toBe(1)
      })

      let stopped = false
      const stopping = handle.stop().then(() => {
        stopped = true
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(stopped).toBe(false)

      await blocker.query('COMMIT')
      await stopping
    } finally {
      blocker.release()
    }

    await waitUntilAcked(nats)
    expect(await receivedMessages(db.pool)).toHaveLength(1)
    expect(results()).toEqual(['processed'])
  })
})
