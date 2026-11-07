// Test fixtures only; not exported from index.ts.
import { randomUUID } from 'node:crypto'
import type { LogisticsEvent } from '@tt/contracts'
const base = {
  eventVersion: 1,
  shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
  occurredAt: '2026-10-28T09:30:00Z',
  receivedAt: '2026-10-28T09:31:12Z',
  correlationId: 'a1e8c78c-931b-4d11-a88f-38a26d4d8e17',
  causationId: null,
} as const

const scan = { facilityId: 'DEPOT-BRNO', scannerId: 'SCANNER-17' }

export function shipmentRegistered(): LogisticsEvent {
  return {
    ...base,
    eventId: randomUUID(),
    eventType: 'shipment.registered',
    producer: 'shipment',
    data: {
      trackingNumber: 'PF-0001',
      originFacilityId: 'DEPOT-PRAHA',
      destination: 'Brno',
      recipientId: 'CUST-42',
      expectedDeliveryAt: '2026-10-29T16:00:00Z',
    },
  }
}

export function parcelAccepted(): LogisticsEvent {
  return { ...base, eventId: randomUUID(), eventType: 'parcel.accepted', producer: 'scan-ingestion', data: scan }
}

export function parcelDelivered(): LogisticsEvent {
  return { ...base, eventId: randomUUID(), eventType: 'parcel.delivered', producer: 'scan-ingestion', data: scan }
}
