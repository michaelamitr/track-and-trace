import type { ShipmentRegisteredEvent } from '@tt/contracts'

export type Shipment = {
  shipmentId: string
  orderReference: string
  trackingNumber: string
  originFacilityId: string
  destination: string
  recipientId: string
  expectedDeliveryAt: Date
  registeredAt: Date
  /** eventId of the shipment.registered event, fixed at registration (ADR-0007). */
  registeredEventId: string
}

/** The fields the e-shop sends; compared to detect a conflicting repeat (ADR-0007). */
export type ShipmentRequest = Pick<
  Shipment,
  'orderReference' | 'originFacilityId' | 'destination' | 'recipientId' | 'expectedDeliveryAt'
>

/** True if the stored shipment was created from the same request data. */
export function matchesRequest(shipment: Shipment, request: ShipmentRequest): boolean {
  return (
    shipment.orderReference === request.orderReference &&
    shipment.originFacilityId === request.originFacilityId &&
    shipment.destination === request.destination &&
    shipment.recipientId === request.recipientId &&
    // Compared as an instant, not as text.
    shipment.expectedDeliveryAt.getTime() === request.expectedDeliveryAt.getTime()
  )
}

/**
 * ISO 8601 in UTC with the Z suffix. Whole seconds are written without
 * milliseconds ("2026-11-11T16:00:00Z"), as in the API and EVENTS.md examples.
 */
export function toIsoUtc(date: Date): string {
  return date.toISOString().replace('.000Z', 'Z')
}

/**
 * The shipment.registered event for a stored shipment. Built only from stored
 * values, so it is the same every time it is built for the same shipment.
 */
export function buildShipmentRegisteredEvent(shipment: Shipment): ShipmentRegisteredEvent {
  const registeredAt = toIsoUtc(shipment.registeredAt)
  return {
    eventId: shipment.registeredEventId,
    eventType: 'shipment.registered',
    eventVersion: 1,
    shipmentId: shipment.shipmentId,
    // Registration happens in this service, so it happens and is accepted at the same time.
    occurredAt: registeredAt,
    receivedAt: registeredAt,
    // correlationId = shipmentId for every event of a shipment (EVENTS.md).
    correlationId: shipment.shipmentId,
    causationId: null,
    producer: 'shipment',
    data: {
      trackingNumber: shipment.trackingNumber,
      originFacilityId: shipment.originFacilityId,
      destination: shipment.destination,
      recipientId: shipment.recipientId,
      expectedDeliveryAt: toIsoUtc(shipment.expectedDeliveryAt),
    },
  }
}

