import type { LogisticsEvent } from '@tt/contracts'

/** The scan types scanners send (docs/scan-ingestion-api.md). */
export const SCAN_TYPES = ['ACCEPTED', 'ARRIVED_AT_HUB', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const

export type ScanType = (typeof SCAN_TYPES)[number]

/** The events this service publishes. */
export type ScanEvent = Extract<LogisticsEvent, { producer: 'scan-ingestion' }>

export type ScanEventType = ScanEvent['eventType']

const EVENT_TYPE_FOR_SCAN: Readonly<Record<ScanType, ScanEventType>> = {
  ACCEPTED: 'parcel.accepted',
  ARRIVED_AT_HUB: 'parcel.arrived_at_hub',
  OUT_FOR_DELIVERY: 'parcel.out_for_delivery',
  DELIVERED: 'parcel.delivered',
}

export class UnknownScanTypeError extends Error {
  override name = 'UnknownScanTypeError'
  constructor(readonly type: string) {
    super(`Unknown scan type "${type}".`)
  }
}

/**
 * The event type for a scan type. Anything else, including internal event type
 * names such as "parcel.delivered", throws UnknownScanTypeError.
 */
export function eventTypeForScan(type: string): ScanEventType {
  if (!Object.hasOwn(EVENT_TYPE_FOR_SCAN, type)) throw new UnknownScanTypeError(type)
  return EVENT_TYPE_FOR_SCAN[type as ScanType]
}

/** A scan as the scanner sent it, after the HTTP schema check. */
export type ScanRequest = {
  eventId: string
  shipmentId: string
  type: ScanType
  occurredAt: string
  facilityId: string
  scannerId: string
}

/**
 * eventId and shipmentId in lowercase, so the same UUID in a different letter
 * case never becomes two events or two shipments. Everything else is unchanged.
 */
export function normalizeScan(scan: ScanRequest): ScanRequest {
  return { ...scan, eventId: scan.eventId.toLowerCase(), shipmentId: scan.shipmentId.toLowerCase() }
}

/** Tolerance for scanner clock skew; fixed, not configurable (MVP). */
export const MAX_OCCURRED_AT_SKEW_MS = 5 * 60 * 1000

/**
 * True if occurredAt is more than MAX_OCCURRED_AT_SKEW_MS after `now`. Exactly
 * the tolerance is still accepted; any past time is accepted (scans sent after
 * a connection outage). `now` is passed in, so callers and tests control time.
 */
export function isOccurredAtTooFarInFuture(occurredAt: string, now: Date): boolean {
  return Date.parse(occurredAt) - now.getTime() > MAX_OCCURRED_AT_SKEW_MS
}

/**
 * ISO 8601 in UTC with the Z suffix. Whole seconds are written without
 * milliseconds ("2026-10-28T09:31:12Z"), as in the API and EVENTS.md examples.
 */
export function toIsoUtc(date: Date): string {
  return date.toISOString().replace('.000Z', 'Z')
}

/**
 * The parcel.* event for a normalized scan. `receivedAt` is when the request
 * arrived. occurredAt is kept exactly as the scanner sent it.
 */
export function buildScanEvent(scan: ScanRequest, receivedAt: Date): ScanEvent {
  return {
    eventId: scan.eventId,
    eventType: eventTypeForScan(scan.type),
    eventVersion: 1,
    shipmentId: scan.shipmentId,
    occurredAt: scan.occurredAt,
    receivedAt: toIsoUtc(receivedAt),
    // correlationId = shipmentId for every event of a shipment (EVENTS.md).
    correlationId: scan.shipmentId,
    causationId: null,
    producer: 'scan-ingestion',
    data: { facilityId: scan.facilityId, scannerId: scan.scannerId },
  }
}
