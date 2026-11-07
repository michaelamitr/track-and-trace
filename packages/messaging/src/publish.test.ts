import type { JetStreamClient } from '@nats-io/jetstream'
import { describe, expect, it, vi } from 'vitest'
import { publishEvent } from './publish.js'
import { parcelDelivered } from './test-fixtures.js'

function fakeJs() {
  const publish = vi.fn().mockResolvedValue({ seq: 7, duplicate: false })
  return { js: { publish } as unknown as JetStreamClient, publish }
}

describe('publishEvent', () => {
  it('publishes to the event subject with msgID = eventId', async () => {
    const { js, publish } = fakeJs()
    const event = parcelDelivered()

    await expect(publishEvent(js, event)).resolves.toEqual({ seq: 7, duplicate: false })
    expect(publish).toHaveBeenCalledOnce()
    const [subject, payload, options] = publish.mock.calls[0]!
    expect(subject).toBe('logistics.parcel.delivered.v1')
    expect(JSON.parse(payload)).toEqual(event)
    expect(options).toEqual({ msgID: event.eventId })
  })

  it('throws for an invalid event and publishes nothing', async () => {
    const { js, publish } = fakeJs()

    await expect(publishEvent(js, { ...parcelDelivered(), eventId: 'nope' })).rejects.toThrow()
    expect(publish).not.toHaveBeenCalled()
  })
})
