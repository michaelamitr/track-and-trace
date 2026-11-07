import type { LogisticsEvent } from '@tt/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeEvents, type ConsumeHandle, type EventHandler } from './consume.js'
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

async function consume(name: ConsumerName, handler: EventHandler) {
  const handle = await consumeEvents(nats.js, name, handler)
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

  it('delivers again after the handler throws, then acks', async () => {
    await ensureConsumer(nats.jsm, 'tracking')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[] = []
    await consume('tracking', async (event) => {
      calls.push(event.eventId)
      if (calls.length === 1) throw new Error('database unavailable')
    })

    const event = parcelDelivered()
    await publishEvent(nats.js, event)

    const settled = await waitUntilSettled('tracking', () => calls.length >= 2)
    expect(calls).toEqual([event.eventId, event.eventId])
    expect(settled.ack_floor.stream_seq).toBe(1)
    expect(settled.delivered.consumer_seq).toBe(2)
  })

  it('terminates invalid JSON and schema-invalid messages without calling the handler', async () => {
    await ensureConsumer(nats.jsm, 'tracking')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stream seq 1'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stream seq 2'))
  })

  it('delivers messages published while stopped when consuming again with the same durable', async () => {
    await ensureConsumer(nats.jsm, 'tracking')
    const first = recorder()
    const handle = await consumeEvents(nats.js, 'tracking', first.handler)
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
