import type { LogisticsEvent } from '@tt/contracts'

// Order matters: it is the lifecycle phase order used as a tie-breaker (rule R2).
export const SHIPMENT_STATUSES = [
  'REGISTERED',
  'ACCEPTED',
  'AT_HUB',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
] as const

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number]

// Tracking consumes every event except sla.breached.
export type TrackingEvent = Exclude<LogisticsEvent, { eventType: 'sla.breached' }>

export const STATUS_BY_EVENT_TYPE: Record<TrackingEvent['eventType'], ShipmentStatus> = {
  'shipment.registered': 'REGISTERED',
  'parcel.accepted': 'ACCEPTED',
  'parcel.arrived_at_hub': 'AT_HUB',
  'parcel.out_for_delivery': 'OUT_FOR_DELIVERY',
  'parcel.delivered': 'DELIVERED',
}