import type { JsMsg } from '@nats-io/jetstream'
import { describe, expect, it, vi } from 'vitest'
import { handleMessage } from './consume.js'
import { parcelDelivered } from './test-fixtures.js'

function fakeMsg(body: string) {
  const msg = {
    subject: 'logistics.parcel.delivered.v1',
    info: { streamSequence: 42 },
    string: () => body,
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
  }
  return msg as typeof msg & JsMsg
}

describe('handleMessage', () => {
  it('acks after the handler resolves', async () => {
    const msg = fakeMsg(JSON.stringify(parcelDelivered()))
    const order: string[] = []
    msg.ack.mockImplementation(() => order.push('ack'))

    await handleMessage(msg, async () => {
      await Promise.resolve()
      order.push('handler')
    })

    expect(order).toEqual(['handler', 'ack'])
    expect(msg.nak).not.toHaveBeenCalled()
  })

  it('naks when the handler throws', async () => {
    const msg = fakeMsg(JSON.stringify(parcelDelivered()))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handleMessage(msg, async () => {
      throw new Error('db down')
    })

    expect(msg.nak).toHaveBeenCalledOnce()
    expect(msg.ack).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid JSON', '{not json'],
    ['a schema-invalid event', JSON.stringify({ ...parcelDelivered(), producer: 'shipment' })],
  ])('terminates %s without calling the handler', async (_, body) => {
    const msg = fakeMsg(body)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = vi.fn()

    await handleMessage(msg, handler)

    expect(handler).not.toHaveBeenCalled()
    expect(msg.term).toHaveBeenCalledOnce()
    expect(msg.ack).not.toHaveBeenCalled()
    expect(msg.nak).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stream seq 42'))
  })
})
