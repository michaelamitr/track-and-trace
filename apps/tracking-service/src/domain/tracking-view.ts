import type { HistoryEntry } from './projection.js'
import type { ShipmentStatus } from './shipment-status.js'

// What the read side returns: the stored read model of one known shipment.

export type TrackingState = {
  shipmentId: string
  trackingNumber: string
  status: ShipmentStatus
  lastLocation: string | null
  lastEventAt: Date
  deliveredAt: Date | null
  updatedAt: Date
}

export type StoredHistoryEntry = Omit<HistoryEntry, 'occurredAt' | 'receivedAt'> & {
  occurredAt: Date
  receivedAt: Date
}

export type TrackingHistory = { shipmentId: string; events: StoredHistoryEntry[] }

export type StoredConflict = {
  eventId: string
  /** Both of the conflicting copy. */
  streamSequence: number
  receivedAt: Date
  differingFields: string[]
}

export type TrackingAnomalies = {
  shipmentId: string
  afterDelivery: StoredHistoryEntry[]
  conflicts: StoredConflict[]
}
