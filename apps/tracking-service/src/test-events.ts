// Test fixtures only.
import { randomUUID } from 'node:crypto'
import type { ShipmentRegisteredEvent } from '@tt/contracts'
import type { TrackingEvent } from './domain/shipment-status.js'

export type ParcelEvent = Exclude<TrackingEvent, ShipmentRegisteredEvent>

export const SHIPMENT_ID = '0d40c8bb-e48f-4311-9223-1a54a7e197e4'

type Overrides = { eventId?: string; shipmentId?: string; receivedAt?: string }

export function registered(occurredAt: string, overrides: Overrides = {}): ShipmentRegisteredEvent {
  const shipmentId = overrides.shipmentId ?? SHIPMENT_ID
  return {
    eventId: overrides.eventId ?? randomUUID(),
    eventType: 'shipment.registered',
    eventVersion: 1,
    shipmentId,
    occurredAt,
    receivedAt: overrides.receivedAt ?? occurredAt,
    correlationId: shipmentId,
    causationId: null,
    producer: 'shipment',
    data: {
      trackingNumber: 'PF-4821093375',
      originFacilityId: 'DEPOT-PRAHA',
      destination: 'Brno',
      recipientId: 'CUST-42',
      expectedDeliveryAt: '2026-10-29T16:00:00Z',
    },
  }
}

export function parcel(
  eventType: ParcelEvent['eventType'],
  occurredAt: string,
  overrides: Overrides & { facilityId?: string } = {},
): ParcelEvent {
  const shipmentId = overrides.shipmentId ?? SHIPMENT_ID
  return {
    eventId: overrides.eventId ?? randomUUID(),
    eventType,
    eventVersion: 1,
    shipmentId,
    occurredAt,
    receivedAt: overrides.receivedAt ?? occurredAt,
    correlationId: shipmentId,
    causationId: null,
    producer: 'scan-ingestion',
    data: { facilityId: overrides.facilityId ?? 'DEPOT-BRNO', scannerId: 'SCANNER-17' },
  }
}
