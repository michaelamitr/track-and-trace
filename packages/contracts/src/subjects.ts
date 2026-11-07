import type { LogisticsEvent } from './events.js'

export const SUBJECTS = {
  shipmentRegistered: 'logistics.shipment.registered.v1',
  parcelAccepted: 'logistics.parcel.accepted.v1',
  parcelArrivedAtHub: 'logistics.parcel.arrived_at_hub.v1',
  parcelOutForDelivery: 'logistics.parcel.out_for_delivery.v1',
  parcelDelivered: 'logistics.parcel.delivered.v1',
  slaBreached: 'logistics.sla.breached.v1',
} as const

export type Subject = (typeof SUBJECTS)[keyof typeof SUBJECTS]

// The subject is derived from the event itself (ADR-0003). The return type is
// checked by the compiler: an event type or version without a matching entry
// in SUBJECTS fails typecheck.
export function subjectForEvent(
  event: Pick<LogisticsEvent, 'eventType' | 'eventVersion'>,
): Subject {
  return `logistics.${event.eventType}.v${event.eventVersion}`
}
