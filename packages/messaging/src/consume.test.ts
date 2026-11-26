import type { JetStreamClient, JsMsg } from '@nats-io/jetstream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeEvents,
  handleMessage,
  StopSignal,
  toStorableText,
  type ConsumeHandle,
  type ConsumeOptions,
  type QuarantineRecord,
} from './consume.js'
import { parcelDelivered } from './test-fixtures.js'

const SUBJECT = 'logistics.parcel.delivered.v1'

/** What happened to a message and the quarantine, in order. */
let calls: string[]

function fakeMsg(body: string | Uint8Array, { deliveryCount = 1, streamSequence = 42 } = {}) {
  const msg = {
    subject: SUBJECT,
    data: typeof body === 'string' ? new TextEncoder().encode(body) : body,
    info: { streamSequence, deliveryCount },
    ack: vi.fn(() => void calls.push('ack')),
    nak: vi.fn((delay?: number) => void calls.push(delay === undefined ? 'nak' : `nak ${delay}`)),
    term: vi.fn(() => void calls.push('term')),
    working: vi.fn(),
  }
  return msg as typeof msg & JsMsg
}

class TransientError extends Error {}

function options(overrides: Partial<ConsumeOptions> = {}) {
  const quarantined: QuarantineRecord[] = []
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const result = {
    handler: vi.fn(async () => {}),
    isTransient: (err: unknown) => err instanceof TransientError,
    quarantine: vi.fn(async (record: QuarantineRecord) => {
      calls.push('quarantine')
      quarantined.push(record)
    }),
    log,
    ...overrides,
  } satisfies ConsumeOptions
  return Object.assign(result, { quarantined })
}

const validBody = () => JSON.stringify(parcelDelivered())

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a valid message', () => {
  it('is acked after the handler resolves', async () => {
    const msg = fakeMsg(validBody())
    const opts = options({
      handler: vi.fn(async () => {
        await Promise.resolve()
        calls.push('handler')
      }),
    })

    await handleMessage(msg, opts)

    expect(calls).toEqual(['handler', 'ack'])
  })

  it('passes the event and the message metadata to the handler', async () => {
    const event = parcelDelivered()
    const opts = options()

    await handleMessage(fakeMsg(JSON.stringify(event), { deliveryCount: 3 }), opts)

    expect(opts.handler).toHaveBeenCalledExactlyOnceWith(event, {
      streamSequence: 42,
      subject: SUBJECT,
      deliveryCount: 3,
    })
  })
})

describe('an invalid message (rule 4)', () => {
  it.each([
    ['invalid JSON', '{not json', /^Not JSON: /],
    ['a schema-invalid event', JSON.stringify({ ...parcelDelivered(), producer: 'shipment' }), /^producer: /],
  ])('%s is quarantined as INVALID with the raw bytes, then acked; the handler is not called', async (_, body, details) => {
    const msg = fakeMsg(body)
    const opts = options()

    await handleMessage(msg, opts)

    expect(calls).toEqual(['quarantine', 'ack'])
    expect(opts.handler).not.toHaveBeenCalled()
    expect(opts.quarantined).toEqual([
      {
        reason: 'INVALID',
        subject: SUBJECT,
        streamSequence: 42,
        rawMessage: msg.data,
        eventId: expect.toSatisfy((id) => id === null || typeof id === 'string'),
        shipmentId: expect.toSatisfy((id) => id === null || typeof id === 'string'),
        details: expect.stringMatching(details),
      },
    ])
    expect(opts.log.warn).toHaveBeenCalledWith(expect.objectContaining({ streamSequence: 42 }), 'invalid message quarantined')
  })

  it('keeps eventId and shipmentId only when they are UUIDs', async () => {
    const event = parcelDelivered()
    const opts = options()

    await handleMessage(fakeMsg(JSON.stringify({ ...event, shipmentId: 'unknown' })), opts)

    expect(opts.quarantined[0]).toMatchObject({
      eventId: event.eventId,
      shipmentId: null,
      details: 'shipmentId: Invalid UUID',
    })
  })

  it('keeps bytes that are not UTF-8 unchanged and strips NUL from details', async () => {
    const raw = Uint8Array.from([0x7b, 0x00, 0xff, 0x7d])
    const opts = options()

    await handleMessage(fakeMsg(raw), opts)

    const [record] = opts.quarantined
    expect(record?.rawMessage).toEqual(raw)
    expect(record?.details).toMatch(/^Not JSON: /)
    expect(record?.details).not.toContain('\u0000')
  })
})

describe('a permanent error (rule 3)', () => {
  it.each([
    [1, 1_000],
    [2, 5_000],
    [3, 30_000],
    [4, 120_000],
  ])('on delivery %i is naked with a delay of %i ms, without a retry in process', async (deliveryCount, delay) => {
    const opts = options({ handler: vi.fn(() => Promise.reject(new Error('unexpected event'))) })

    await handleMessage(fakeMsg(validBody(), { deliveryCount }), opts)

    expect(calls).toEqual([`nak ${delay}`])
    expect(opts.handler).toHaveBeenCalledOnce()
    expect(opts.quarantine).not.toHaveBeenCalled()
    expect(opts.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryCount, retryInMs: delay }),
      'permanent error, message naked for a later delivery',
    )
  })

  it.each([5, 6])('on delivery %i is quarantined as PROCESSING_FAILED, then acked', async (deliveryCount) => {
    const event = parcelDelivered()
    const msg = fakeMsg(JSON.stringify(event), { deliveryCount })
    const opts = options({ handler: vi.fn(() => Promise.reject(new Error('Unexpected sla.breached'))) })

    await handleMessage(msg, opts)

    expect(calls).toEqual(['quarantine', 'ack'])
    expect(opts.quarantined).toEqual([
      {
        reason: 'PROCESSING_FAILED',
        subject: SUBJECT,
        streamSequence: 42,
        rawMessage: msg.data,
        eventId: event.eventId,
        shipmentId: event.shipmentId,
        details: 'Unexpected sla.breached',
      },
    ])
    expect(opts.log.error).toHaveBeenCalledOnce()
  })

  it('strips NUL characters and unpaired surrogates from the error text', async () => {
    const opts = options({ handler: vi.fn(() => Promise.reject(new Error('bad\u0000 value \uD800!'))) })

    await handleMessage(fakeMsg(validBody(), { deliveryCount: 5 }), opts)

    expect(opts.quarantined[0]?.details).toBe('bad value �!')
  })

  it('uses the configured delays', async () => {
    const opts = options({
      handler: vi.fn(() => Promise.reject(new Error('boom'))),
      timing: { nakDelaysMs: [10, 20] },
    })

    await handleMessage(fakeMsg(validBody(), { deliveryCount: 2 }), opts)
    await handleMessage(fakeMsg(validBody(), { deliveryCount: 3 }), opts)

    expect(calls).toEqual(['nak 20', 'quarantine', 'ack'])
  })
})

describe('a transient error (rule 2)', () => {
  it('retries the same message with growing delays capped at 30 s, sends "working", and acks only after success', async () => {
    vi.useFakeTimers()
    const attempts: number[] = []
    const failures = 8
    const opts = options({
      handler: vi.fn(async () => {
        attempts.push(Date.now())
        if (attempts.length <= failures) throw new TransientError('database unavailable')
      }),
    })
    const msg = fakeMsg(validBody())

    const handled = handleMessage(msg, opts)
    // 1+2+4+8+16+30+30+30 = 121 s of waiting.
    await vi.advanceTimersByTimeAsync(125_000)
    await handled

    const waits = attempts.slice(1).map((time, index) => time - attempts[index]!)
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
    expect(calls).toEqual(['ack'])
    // Every 10 s, well within ack_wait (30 s).
    expect(msg.working.mock.calls.length).toBeGreaterThanOrEqual(12)
    expect(opts.log.warn).toHaveBeenCalledTimes(failures)
    expect(opts.log.info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ failures }),
      'message processing recovered',
    )
  })

  it('neither acks nor naks while it keeps failing', async () => {
    vi.useFakeTimers()
    const opts = options({ handler: vi.fn(() => Promise.reject(new TransientError('down'))) })
    const msg = fakeMsg(validBody(), { deliveryCount: 5 })
    const signal = new StopSignal()

    const handled = handleMessage(msg, opts, signal)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(calls).toEqual([])
    expect(vi.mocked(opts.handler).mock.calls.length).toBeGreaterThan(20)
    expect(opts.quarantine).not.toHaveBeenCalled()

    signal.stop()
    await handled
  })

  it('is naked without a delay and not acked when the consumer stops during the wait', async () => {
    vi.useFakeTimers()
    const opts = options({ handler: vi.fn(() => Promise.reject(new TransientError('down'))) })
    const signal = new StopSignal()

    const handled = handleMessage(fakeMsg(validBody()), opts, signal)
    await vi.advanceTimersByTimeAsync(3_500)
    signal.stop()
    await handled

    expect(calls).toEqual(['nak'])
    expect(opts.handler).toHaveBeenCalledTimes(3)
  })
})

describe('a failure to write the quarantine (rule 4)', () => {
  it('is retried like a transient error, whatever the error, and the message is acked only after the write', async () => {
    vi.useFakeTimers()
    let writes = 0
    const opts = options({
      quarantine: vi.fn(async () => {
        writes += 1
        calls.push(`write ${writes}`)
        if (writes < 3) throw new Error('relation does not exist')
      }),
    })

    const handled = handleMessage(fakeMsg('{not json'), opts)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toEqual(['write 1', 'write 2'])
    await vi.advanceTimersByTimeAsync(2_000)
    await handled

    expect(calls).toEqual(['write 1', 'write 2', 'write 3', 'ack'])
  })

  it('of a PROCESSING_FAILED message is retried too, and the message is naked if the consumer stops', async () => {
    vi.useFakeTimers()
    const signal = new StopSignal()
    const opts = options({
      handler: vi.fn(() => Promise.reject(new Error('boom'))),
      quarantine: vi.fn(() => Promise.reject(new Error('quarantine down'))),
    })

    const handled = handleMessage(fakeMsg(validBody(), { deliveryCount: 5 }), opts, signal)
    await vi.advanceTimersByTimeAsync(5_000)
    signal.stop()
    await handled

    expect(vi.mocked(opts.quarantine).mock.calls.length).toBeGreaterThan(1)
    expect(calls).toEqual(['nak'])
  })
})

describe('toStorableText', () => {
  it('removes NUL and replaces unpaired surrogates, keeping valid pairs', () => {
    expect(toStorableText('a\u0000b\uDC00c😀')).toBe('ab�c😀')
  })
})

/** A consumer whose fetch() delivers pushed messages, one per pull, as NATS does with max_messages 1. */
function fakeConsumer() {
  const queue: JsMsg[] = []
  let waiting: ((msg: JsMsg | null) => void) | undefined
  const fetches: unknown[] = []
  const consumer = {
    async fetch(opts: unknown) {
      fetches.push(opts)
      return {
        stop() {
          waiting?.(null)
        },
        async *[Symbol.asyncIterator]() {
          const msg = queue.shift() ?? (await new Promise<JsMsg | null>((resolve) => (waiting = resolve)))
          waiting = undefined
          if (msg) yield msg
        },
      }
    },
  }
  const js = { consumers: { get: async () => consumer } } as unknown as JetStreamClient
  return {
    js,
    fetches,
    push(msg: JsMsg) {
      if (waiting) waiting(msg)
      else queue.push(msg)
    },
  }
}

describe('consumeEvents', () => {
  let handle: ConsumeHandle | undefined

  afterEach(async () => {
    await handle?.stop()
    handle = undefined
  })

  it('takes strictly one message at a time: the next pull only after the previous message is acked', async () => {
    const nats = fakeConsumer()
    let finish!: () => void
    const opts = options({
      handler: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      ),
    })
    const first = fakeMsg(validBody(), { streamSequence: 1 })
    const second = fakeMsg(validBody(), { streamSequence: 2 })
    nats.push(first)
    nats.push(second)

    handle = await consumeEvents(nats.js, 'tracking', opts)
    await vi.waitFor(() => expect(opts.handler).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(nats.fetches).toEqual([{ max_messages: 1, expires: 5_000 }])
    expect(opts.handler).toHaveBeenCalledOnce()

    finish()
    await vi.waitFor(() => expect(opts.handler).toHaveBeenCalledTimes(2))
    expect(first.ack).toHaveBeenCalledOnce()
    expect(nats.fetches).toHaveLength(2)
    finish()
  })

  it('continues with the next message after a permanent error', async () => {
    const nats = fakeConsumer()
    const opts = options({
      handler: vi.fn(async (_event, metadata) => {
        if (metadata.streamSequence === 1) throw new Error('poison')
      }),
    })
    const poison = fakeMsg(validBody(), { streamSequence: 1 })
    const next = fakeMsg(validBody(), { streamSequence: 2 })
    nats.push(poison)
    nats.push(next)

    handle = await consumeEvents(nats.js, 'tracking', opts)

    await vi.waitFor(() => expect(next.ack).toHaveBeenCalledOnce())
    expect(poison.nak).toHaveBeenCalledExactlyOnceWith(1_000)
  })

  it('stop() during a transient wait naks the message without a delay, never acks it, and takes no more', async () => {
    const nats = fakeConsumer()
    const opts = options({
      handler: vi.fn(() => Promise.reject(new TransientError('down'))),
      timing: { retryBaseMs: 60_000 },
    })
    const waiting = fakeMsg(validBody(), { streamSequence: 1 })
    const later = fakeMsg(validBody(), { streamSequence: 2 })
    nats.push(waiting)
    nats.push(later)
    handle = await consumeEvents(nats.js, 'tracking', opts)
    await vi.waitFor(() => expect(opts.log.warn).toHaveBeenCalledOnce())

    const started = Date.now()
    await handle.stop()

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(waiting.nak).toHaveBeenCalledExactlyOnceWith()
    expect(waiting.ack).not.toHaveBeenCalled()
    expect(nats.fetches).toHaveLength(1)
    expect(later.ack).not.toHaveBeenCalled()
  })

  it('stop() lets the message in progress finish and acks it', async () => {
    const nats = fakeConsumer()
    let finish!: () => void
    const opts = options({
      handler: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      ),
    })
    const msg = fakeMsg(validBody())
    nats.push(msg)
    handle = await consumeEvents(nats.js, 'tracking', opts)
    await vi.waitFor(() => expect(opts.handler).toHaveBeenCalledOnce())

    const stopped = handle.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(msg.ack).not.toHaveBeenCalled()
    finish()
    await stopped

    expect(calls).toEqual(['ack'])
    expect(nats.fetches).toHaveLength(1)
  })

  it('stop() ends a pull that waits for a message', async () => {
    const nats = fakeConsumer()
    handle = await consumeEvents(nats.js, 'tracking', options())
    await vi.waitFor(() => expect(nats.fetches).toHaveLength(1))

    await handle.stop()

    expect(nats.fetches).toHaveLength(1)
  })
})
