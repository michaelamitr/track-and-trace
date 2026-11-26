import type { LogisticsEvent } from '@tt/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeEvents,
  type ConsumeHandle,
  type ConsumeOptions,
  type EventHandler,
  type MessageMetadata,
  type QuarantineRecord,
} from './consume.js'
import { ensureConsumer, type ConsumerName } from './consumers.js'
import { publishEvent } from './publish.js'
import { ensureStream, LOGISTICS_STREAM } from './stream.js'
import { parcelAccepted, parcelDelivered, shipmentRegistered } from './test-fixtures.js'
import { startNats, type TestNats } from './test-nats.js'

let nats: TestNats
let handles: ConsumeHandle[] = []

beforeAll(async () => {
  nats = await startNats()
})

afterAll(async () => {
  await nats?.stop()
})

beforeEach(async () => {
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
  await ensureStream(nats.jsm)
})

afterEach(async () => {
  await Promise.all(handles.map((h) => h.stop()))
  handles = []
  vi.restoreAllMocks()
})

const silent = { info: () => {}, warn: () => {}, error: () => {} }
let quarantined: QuarantineRecord[] = []

beforeEach(() => {
  quarantined = []
})

/** Short delays, so a nak'ed message comes back quickly. */
function consumeOptions(handler: EventHandler, overrides: Partial<ConsumeOptions> = {}): ConsumeOptions {
  return {
    handler,
    isTransient: () => false,
    quarantine: async (record) => void quarantined.push(record),
    log: silent,
    timing: { nakDelaysMs: [100, 100, 100, 100], fetchExpiresMs: 1_000 },
    ...overrides,
  }
}

async function consume(name: ConsumerName, handler: EventHandler, overrides: Partial<ConsumeOptions> = {}) {
  const handle = await consumeEvents(nats.js, name, consumeOptions(handler, overrides))
  handles.push(handle)
  return handle
}

function info(name: ConsumerName) {
  return nats.jsm.consumers.info(LOGISTICS_STREAM.name, name)
}

/** Polls consumer info until nothing is pending or waiting for an ack. */
async function waitUntilSettled(name: ConsumerName, extra: () => boolean = () => true) {
  await vi.waitFor(
    async () => {
      const i = await info(name)
      expect(i.num_pending).toBe(0)
      expect(i.num_ack_pending).toBe(0)
      expect(extra()).toBe(true)
    },
    { timeout: 10_000, interval: 50 },
  )
  return info(name)
}

function recorder() {
  const received: LogisticsEvent[] = []
  const handler: EventHandler = async (event) => {
    received.push(event)
  }
  return { received, handler }
}

describe('consumeEvents', () => {
  it('sla-monitoring receives shipment.registered and parcel.delivered, not parcel.accepted', async () => {
    await ensureConsumer(nats.jsm, 'sla-monitoring')
    const { received, handler } = recorder()
    await consume('sla-monitoring', handler)

    await publishEvent(nats.js, parcelAccepted())
    await publishEvent(nats.js, shipmentRegistered())
    await publishEvent(nats.js, parcelDelivered())

    await waitUntilSettled('sla-monitoring', () => received.length >= 2)
    expect(received.map((e) => e.eventType)).toEqual(['shipment.registered', 'parcel.delivered'])
  })

  it('acks after the handler resolves and does not deliver again', async () => {
    await ensureConsumer(nats.jsm, 'tracking')
    const { received, handler } = recorder()
    await consume('tracking', handler)

    const event = parcelDelivered()
    await publishEvent(nats.js, event)

    const settled = await waitUntilSettled('tracking', () => received.length >= 1)
    expect(settled.ack_floor.stream_seq).toBe(1)
    expect(settled.delivered.consumer_seq).toBe(1)
    expect(settled.num_redelivered).toBe(0)
    expect(received.map((e) => e.eventId)).toEqual([event.eventId])
  })

  it('delivers again after a permanent error, then acks', async () => {
    await ensureConsumer(nats.jsm, 'tracking')
    const calls: string[] = []
    const metadata: MessageMetadata[] = []
    await consume('tracking', async (event, meta) => {
      calls.push(event.eventId)
      metadata.push(meta)
      if (calls.length === 1) throw new Error('unexpected')
    })

    const event = parcelDelivered()
    const { seq } = await publishEvent(nats.js, event)

    const settled = await waitUntilSettled('tracking', () => calls.length >= 2)
    expect(calls).toEqual([event.eventId, event.eventId])
    // The redelivery is the same message: same stream sequence, higher delivery count.
    expect(metadata).toEqual([
      { streamSequence: seq, subject: 'logistics.parcel.delivered.v1', deliveryCount: 1 },
      { streamSequence: seq, subject: 'logistics.parcel.delivered.v1', deliveryCount: 2 },
    ])
    expect(settled.ack_floor.stream_seq).toBe(1)
    expect(settled.delivered.consumer_seq).toBe(2)
  })

  it('quarantines invalid JSON and schema-invalid messages without calling the handler, and acks them', async () => {
    await ensureConsumer(nats.jsm, 'tracking')
    const { received, handler } = recorder()
    await consume('tracking', handler)

    await nats.js.publish('logistics.parcel.delivered.v1', '{not json')
    await nats.js.publish(
      'logistics.parcel.accepted.v1',
      JSON.stringify({ ...parcelAccepted(), producer: 'shipment' }),
    )
    // A valid event after the invalid ones shows the consumer moved past them.
    const valid = parcelDelivered()
    await publishEvent(nats.js, valid)

    const settled = await waitUntilSettled('tracking', () => received.length >= 1)
    expect(received.map((e) => e.eventId)).toEqual([valid.eventId])
    expect(settled.ack_floor.stream_seq).toBe(3)
    // Three messages, three deliveries: nothing was redelivered.
    expect(settled.delivered.consumer_seq).toBe(3)
    expect(settled.num_redelivered).toBe(0)
    expect(quarantined.map((record) => [record.reason, record.streamSequence, record.subject])).toEqual([
      ['INVALID', 1, 'logistics.parcel.delivered.v1'],
      ['INVALID', 2, 'logistics.parcel.accepted.v1'],
    ])
    expect(new TextDecoder().decode(quarantined[0]?.rawMessage)).toBe('{not json')
  })

  it('quarantines a message that fails on its 5th delivery and acks it; NATS never gives up (max_deliver -1)', async () => {
    await ensureConsumer(nats.jsm, 'tracking')
    const deliveries: number[] = []
    const { received, handler: record } = recorder()
    await consume('tracking', async (event, meta) => {
      if (meta.streamSequence === 1) {
        deliveries.push(meta.deliveryCount)
        throw new Error('poison')
      }
      await record(event, meta)
    })

    const poison = parcelDelivered()
    await publishEvent(nats.js, poison)
    const next = parcelAccepted()
    await publishEvent(nats.js, next)

    const settled = await waitUntilSettled('tracking', () => quarantined.length >= 1)
    expect(deliveries).toEqual([1, 2, 3, 4, 5])
    expect(received.map((e) => e.eventId)).toEqual([next.eventId])
    expect(quarantined).toMatchObject([{ reason: 'PROCESSING_FAILED', streamSequence: 1, eventId: poison.eventId, details: 'poison' }])
    expect(settled.ack_floor.stream_seq).toBe(2)
    expect(settled.config.max_deliver).toBe(-1)
  })

  it('retries a transient error in process: the message is delivered once, and "working" keeps it past ack_wait', async () => {
    await ensureConsumer(nats.jsm, 'tracking')
    // A short ack_wait for this test only; the declared one is 30 s.
    await nats.jsm.consumers.update(LOGISTICS_STREAM.name, 'tracking', { ack_wait: 1_000_000_000 })
    const deliveries: number[] = []
    const started = Date.now()
    await consume(
      'tracking',
      async (_event, meta) => {
        deliveries.push(meta.deliveryCount)
        if (Date.now() - started < 3_000) throw new Error('database unavailable')
      },
      {
        isTransient: () => true,
        timing: { retryBaseMs: 200, retryMaxMs: 400, workingIntervalMs: 300, fetchExpiresMs: 1_000 },
      },
    )

    await publishEvent(nats.js, parcelDelivered())

    const settled = await waitUntilSettled('tracking', () => Date.now() - started > 3_000 && deliveries.length > 1)
    expect(new Set(deliveries)).toEqual(new Set([1]))
    expect(settled.num_redelivered).toBe(0)
    expect(settled.delivered.consumer_seq).toBe(1)
    expect(quarantined).toEqual([])
  })

  it('delivers messages published while stopped when consuming again with the same durable', async () => {
    await ensureConsumer(nats.jsm, 'tracking')
    const first = recorder()
    const handle = await consumeEvents(nats.js, 'tracking', consumeOptions(first.handler))
    await publishEvent(nats.js, shipmentRegistered())
    await waitUntilSettled('tracking', () => first.received.length >= 1)
    await handle.stop()

    const whileStopped = [parcelAccepted(), parcelDelivered()]
    for (const event of whileStopped) await publishEvent(nats.js, event)

    const stopped = await info('tracking')
    expect(stopped.config.durable_name).toBe('tracking')
    expect(stopped.num_pending).toBe(2)

    const second = recorder()
    await consume('tracking', second.handler)
    await waitUntilSettled('tracking', () => second.received.length >= 2)
    expect(second.received.map((e) => e.eventId)).toEqual(whileStopped.map((e) => e.eventId))
    expect(first.received).toHaveLength(1)
  })
})
