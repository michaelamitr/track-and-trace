import type { ShipmentRegisteredEvent } from '@tt/contracts'
import type { TrackingProjection } from './projection.js'
import type { TrackingEvent } from './shipment-status.js'

/**
 * The registration of a shipment among its events, or null while it is not
 * known. If a producer ever registered it twice (two eventIds), the first one
 * in R2 order is used, so the result does not depend on the arrival order.
 */
export function findRegistration(
  events: TrackingEvent[],
  projection: TrackingProjection,
): ShipmentRegisteredEvent | null {
  const first = projection.history.find((entry) => entry.eventType === 'shipment.registered')
  const event = events.find((candidate) => candidate.eventId === first?.eventId)
  return event?.eventType === 'shipment.registered' ? event : null
}
