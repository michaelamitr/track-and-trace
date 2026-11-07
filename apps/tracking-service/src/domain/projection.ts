import {
  SHIPMENT_STATUSES,
  STATUS_BY_EVENT_TYPE,
  type ShipmentStatus,
  type TrackingEvent,
} from './shipment-status.js'

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

// R1: the earlier receivedAt instant wins. Only for the same instant does the code-unit
// smaller string win, so the kept copy does not depend on input order.
function wasReceivedEarlier(candidate: TrackingEvent, kept: TrackingEvent): boolean {
  const difference = Date.parse(candidate.receivedAt) - Date.parse(kept.receivedAt)
  return difference < 0 || (difference === 0 && candidate.receivedAt < kept.receivedAt)
}

// R1: copies with the same eventId count once, and the earliest receivedAt is kept.
function dedupeByEventId(events: TrackingEvent[]): TrackingEvent[] {
  const earliestById = new Map<string, TrackingEvent>()
  for (const event of events) {
    const kept = earliestById.get(event.eventId)
    if (kept === undefined || wasReceivedEarlier(event, kept)) {
      earliestById.set(event.eventId, event)
    }
  }
  return [...earliestById.values()]
}

// R2: the lifecycle phase is the position of the event's status in SHIPMENT_STATUSES.
function lifecyclePhase(event: TrackingEvent): number {
  return SHIPMENT_STATUSES.indexOf(STATUS_BY_EVENT_TYPE[event.eventType])
}

// R2: plain code-unit comparison, so the order cannot depend on the machine's locale.
function compareEventIds(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

// R2: order by occurredAt, then lifecycle phase, then eventId. Never by arrival order.
function compareEvents(a: TrackingEvent, b: TrackingEvent): number {
  return (
    Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
    lifecyclePhase(a) - lifecyclePhase(b) ||
    compareEventIds(a.eventId, b.eventId)
  )
}

// R4: the first DELIVERED in the ordered history is the final state.
function findFirstDelivered(ordered: TrackingEvent[]): TrackingEvent | undefined {
  return ordered.find((event) => STATUS_BY_EVENT_TYPE[event.eventType] === 'DELIVERED')
}

// R3: before delivery, the last event in the ordered history determines the status.
// R4: once delivered, the first DELIVERED determines it.
function findDeterminingEvent(
  ordered: TrackingEvent[],
  firstDelivered: TrackingEvent | undefined,
): TrackingEvent | undefined {
  return firstDelivered ?? ordered.at(-1)
}

// R5: an event ordered after the first DELIVERED is an anomaly.
// R6: only the R2 order counts, so a late arrival ordered before the delivery is normal history.
function isAnomaly(event: TrackingEvent, firstDelivered: TrackingEvent | undefined): boolean {
  return firstDelivered !== undefined && compareEvents(event, firstDelivered) > 0
}

// Output: shipment.registered has no facilityId, so its location is null.
function facilityIdOf(event: TrackingEvent): string | null {
  return event.eventType === 'shipment.registered' ? null : event.data.facilityId
}

// Output: one history entry per unique event, built as a new object.
function toHistoryEntry(
  event: TrackingEvent,
  firstDelivered: TrackingEvent | undefined,
): HistoryEntry {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    status: STATUS_BY_EVENT_TYPE[event.eventType],
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    facilityId: facilityIdOf(event),
    isAnomaly: isAnomaly(event, firstDelivered),
  }
}

export function project(events: TrackingEvent[]): TrackingProjection {
  const ordered = dedupeByEventId(events).toSorted(compareEvents)
  const firstDelivered = findFirstDelivered(ordered)
  const determining = findDeterminingEvent(ordered, firstDelivered)

  return {
    status: determining ? STATUS_BY_EVENT_TYPE[determining.eventType] : null,
    lastLocation: determining ? facilityIdOf(determining) : null,
    lastEventAt: determining?.occurredAt ?? null,
    deliveredAt: firstDelivered?.occurredAt ?? null,
    history: ordered.map((event) => toHistoryEntry(event, firstDelivered)),
  }
}