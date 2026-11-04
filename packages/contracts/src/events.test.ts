import { describe, expect, it } from 'vitest'
import { LogisticsEventSchema } from './events.js'

// Fields shared by all fixtures. Every ID is a valid UUID v4.
const base = {
  eventVersion: 1,
  shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
  occurredAt: '2026-10-28T09:30:00Z',
  receivedAt: '2026-10-28T09:31:12Z',
  correlationId: 'a1e8c78c-931b-4d11-a88f-38a26d4d8e17',
  causationId: null,
}

function shipmentRegistered(overrides: Record<string, unknown> = {}) {
  return {
    ...base,
    eventId: '5b3f7d0e-2c1a-4e8b-9f6d-3a2b1c0d9e8f',
    eventType: 'shipment.registered',
    producer: 'shipment',
    data: {
      trackingNumber: 'PF-0001',
      originFacilityId: 'DEPOT-PRAHA',
      destination: 'Brno',
      recipientId: 'CUST-42',
      expectedDeliveryAt: '2026-10-29T16:00:00Z',
    },
    ...overrides,
  }
}

function parcelDelivered(overrides: Record<string, unknown> = {}) {
  return {
    ...base,
    eventId: '4d36957b-6c2b-47e0-b784-13a9b00c0b67',
    eventType: 'parcel.delivered',
    producer: 'scan-ingestion',
    data: { facilityId: 'DEPOT-BRNO', scannerId: 'SCANNER-17' },
    ...overrides,
  }
}

function slaBreached(overrides: Record<string, unknown> = {}) {
  return {
    ...base,
    eventId: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924',
    eventType: 'sla.breached',
    producer: 'sla-monitoring',
    causationId: '5b3f7d0e-2c1a-4e8b-9f6d-3a2b1c0d9e8f',
    data: {
      incidentId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      expectedDeliveryAt: '2026-10-29T16:00:00Z',
      effectiveDeadline: '2026-10-29T18:00:00Z',
      reason: 'NOT_DELIVERED_IN_TIME',
      deliveredAt: null,
    },
    ...overrides,
  }
}

describe('LogisticsEventSchema', () => {
  it('accepts a valid shipment.registered event', () => {
    expect(LogisticsEventSchema.safeParse(shipmentRegistered()).success).toBe(true)
  })

  it('accepts a valid parcel.delivered event', () => {
    expect(LogisticsEventSchema.safeParse(parcelDelivered()).success).toBe(true)
  })

  it('accepts a valid sla.breached event', () => {
    expect(LogisticsEventSchema.safeParse(slaBreached()).success).toBe(true)
  })

  it('rejects a payload that does not match the event type', () => {
    const result = LogisticsEventSchema.safeParse(
      shipmentRegistered({ data: { facilityId: 'DEPOT-BRNO', scannerId: 'SCANNER-17' } }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['data', 'trackingNumber'])
  })

  it('rejects an event sent by the wrong producer', () => {
    const result = LogisticsEventSchema.safeParse(parcelDelivered({ producer: 'shipment' }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['producer'])
  })

  it('rejects an unsupported event version', () => {
    const result = LogisticsEventSchema.safeParse(parcelDelivered({ eventVersion: 2 }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['eventVersion'])
  })

  it('rejects an unknown event type', () => {
    const result = LogisticsEventSchema.safeParse(parcelDelivered({ eventType: 'parcel.lost' }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['eventType'])
  })
})