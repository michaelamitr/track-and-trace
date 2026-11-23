import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parcel, SHIPMENT_ID } from '../test-events.js'
import { createEventHandler } from './handle-event.js'

const log = { info: vi.fn(), warn: vi.fn() }
const processEvent = vi.fn()
const handle = createEventHandler({ processEvent, log })
const metadata = { streamSequence: 42, subject: 'logistics.parcel.delivered.v1', deliveryCount: 1 }

beforeEach(() => {
  vi.resetAllMocks()
})

describe('event handler', () => {
  it.each([
    ['processed', 'info'],
    ['duplicate', 'info'],
    ['waiting_for_registration', 'info'],
    ['conflict', 'warn'],
  ] as const)('writes one structured line for %s, as %s', async (result, level) => {
    processEvent.mockResolvedValue(result)
    const event = parcel('parcel.delivered', '2026-10-28T14:00:00Z')

    await handle(event, metadata)

    expect(processEvent).toHaveBeenCalledExactlyOnceWith(event, metadata)
    expect(log[level]).toHaveBeenCalledExactlyOnceWith(
      {
        eventId: event.eventId,
        eventType: 'parcel.delivered',
        shipmentId: SHIPMENT_ID,
        correlationId: event.correlationId,
        streamSequence: 42,
        result,
      },
      expect.any(String),
    )
    expect(log[level === 'info' ? 'warn' : 'info']).not.toHaveBeenCalled()
  })

  it('throws the error of a failed processing and logs no result, so the message is not acked', async () => {
    const err = new Error('database unavailable')
    processEvent.mockRejectedValue(err)

    await expect(handle(parcel('parcel.delivered', '2026-10-28T14:00:00Z'), metadata)).rejects.toBe(err)

    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('rejects sla.breached, which Tracking does not consume', async () => {
    const event = {
      ...parcel('parcel.delivered', '2026-10-28T14:00:00Z'),
      eventType: 'sla.breached' as const,
      producer: 'sla-monitoring' as const,
      data: {
        incidentId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        expectedDeliveryAt: '2026-10-29T16:00:00Z',
        effectiveDeadline: '2026-10-29T18:00:00Z',
        reason: 'NOT_DELIVERED_IN_TIME' as const,
        deliveredAt: null,
      },
    }

    await expect(handle(event, metadata)).rejects.toThrow('Unexpected sla.breached on logistics.parcel.delivered.v1')
    expect(processEvent).not.toHaveBeenCalled()
  })
})
