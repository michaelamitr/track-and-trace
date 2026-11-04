import { describe, expect, it } from 'vitest'
import { EventEnvelopeSchema } from './envelope.js'

// A valid event based on the example in the assignment (section 7.3).
// Overrides let each test change just the one field it is about.
function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: '4d36957b-6c2b-47e0-b784-13a9b00c0b67',
    eventType: 'parcel.arrived_at_hub',
    eventVersion: 1,
    shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
    occurredAt: '2026-10-28T09:30:00Z',
    receivedAt: '2026-10-28T09:31:12Z',
    correlationId: 'a1e8c78c-931b-4d11-a88f-38a26d4d8e17',
    causationId: null,
    producer: 'scan-ingestion',
    data: { facilityId: 'DEPOT-BRNO', scannerId: 'SCANNER-17' },
    ...overrides,
  }
}

describe('EventEnvelopeSchema', () => {
  it('accepts a valid event', () => {
    expect(EventEnvelopeSchema.safeParse(validEvent()).success).toBe(true)
  })

  it('rejects a time with an offset instead of UTC', () => {
    const result = EventEnvelopeSchema.safeParse(
      validEvent({ occurredAt: '2026-10-28T10:30:00+01:00' }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['occurredAt'])
  })

  it('rejects an unknown event type', () => {
    const result = EventEnvelopeSchema.safeParse(validEvent({ eventType: 'parcel.lost' }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['eventType'])
  })

  it('rejects an event without eventId', () => {
    const result = EventEnvelopeSchema.safeParse(validEvent({ eventId: undefined }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['eventId'])
  })

  it('rejects a non-positive eventVersion', () => {
    const result = EventEnvelopeSchema.safeParse(validEvent({ eventVersion: 0 }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['eventVersion'])
  })
})