import { LogisticsEventSchema } from '@tt/contracts'
import { describe, expect, it } from 'vitest'
import { buildShipmentRegisteredEvent, matchesRequest, toIsoUtc, type Shipment } from './shipment.js'

// Every value differs from the others, so a swapped field is detected.
const shipment: Shipment = {
  shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
  orderReference: 'ESHOP-2026-004211',
  trackingNumber: 'PF-4821093375',
  originFacilityId: 'PRG-HUB-01',
  destination: 'Brno',
  recipientId: 'cust-88231',
  expectedDeliveryAt: new Date('2026-11-11T16:00:00Z'),
  registeredAt: new Date('2026-11-10T09:15:30.123Z'),
  registeredEventId: '5b3f7d0e-2c1a-4e8b-9f6d-3a2b1c0d9e8f',
}

describe('buildShipmentRegisteredEvent', () => {
  const event = buildShipmentRegisteredEvent(shipment)

  it('passes LogisticsEventSchema', () => {
    expect(LogisticsEventSchema.parse(event)).toEqual(event)
  })

  it('maps the shipment to the envelope and data', () => {
    expect(event).toEqual({
      eventId: '5b3f7d0e-2c1a-4e8b-9f6d-3a2b1c0d9e8f',
      eventType: 'shipment.registered',
      eventVersion: 1,
      shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
      occurredAt: '2026-11-10T09:15:30.123Z',
      receivedAt: '2026-11-10T09:15:30.123Z',
      correlationId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
      causationId: null,
      producer: 'shipment',
      data: {
        trackingNumber: 'PF-4821093375',
        originFacilityId: 'PRG-HUB-01',
        destination: 'Brno',
        recipientId: 'cust-88231',
        expectedDeliveryAt: '2026-11-11T16:00:00Z',
      },
    })
  })

  it('uses the shipmentId as correlationId', () => {
    expect(event.correlationId).toBe(shipment.shipmentId)
  })

  it('uses registered_at as both occurredAt and receivedAt', () => {
    expect(event.occurredAt).toBe(shipment.registeredAt.toISOString())
    expect(event.receivedAt).toBe(event.occurredAt)
  })

  it('reuses the stored eventId, so building it again gives the same event', () => {
    expect(buildShipmentRegisteredEvent(shipment)).toEqual(event)
  })
})

describe('matchesRequest', () => {
  const request = {
    orderReference: shipment.orderReference,
    originFacilityId: shipment.originFacilityId,
    destination: shipment.destination,
    recipientId: shipment.recipientId,
    expectedDeliveryAt: new Date('2026-11-11T16:00:00.000Z'),
  }

  it('matches the same data, comparing expectedDeliveryAt as an instant', () => {
    expect(matchesRequest(shipment, request)).toBe(true)
  })

  it.each([
    ['orderReference', 'ESHOP-OTHER'],
    ['originFacilityId', 'BRQ-HUB-02'],
    ['destination', 'Ostrava'],
    ['recipientId', 'cust-1'],
    ['expectedDeliveryAt', new Date('2026-11-11T16:00:00.001Z')],
  ] as const)('does not match a different %s', (field, value) => {
    expect(matchesRequest(shipment, { ...request, [field]: value })).toBe(false)
  })
})

describe('toIsoUtc', () => {
  it('drops zero milliseconds and keeps others', () => {
    expect(toIsoUtc(new Date('2026-11-11T16:00:00Z'))).toBe('2026-11-11T16:00:00Z')
    expect(toIsoUtc(new Date('2026-11-11T16:00:00.120Z'))).toBe('2026-11-11T16:00:00.120Z')
  })
})
