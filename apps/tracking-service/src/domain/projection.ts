import type { ShipmentStatus, TrackingEvent } from './shipment-status.js'

export type HistoryEntry = {
  eventId: string
  eventType: TrackingEvent['eventType']
  status: ShipmentStatus
  occurredAt: string
  receivedAt: string
  facilityId: string | null
  isAnomaly: boolean
}

export type TrackingProjection = {
  status: ShipmentStatus | null
  lastLocation: string | null
  lastEventAt: string | null
  deliveredAt: string | null
  history: HistoryEntry[]
}

export function project(events: TrackingEvent[]): TrackingProjection {
  throw new Error('Not implemented yet')
}