import { isDeepStrictEqual } from 'node:util'
import type { TrackingEvent } from './shipment-status.js'

/**
 * Fields that hold a time, by name as in the result of differingFields. They
 * are compared as instants. compare-copies.test.ts checks that this is every
 * time field of the contract (except receivedAt, which is ignored).
 */
export const TIME_FIELDS: ReadonlySet<string> = new Set(['occurredAt', 'data.expectedDeliveryAt'])

/** Envelope fields by name and payload fields as "data.<field>", without receivedAt. */
function comparableFields(event: TrackingEvent): Map<string, unknown> {
  const { receivedAt: _ignored, data, ...envelope } = event
  return new Map<string, unknown>([
    ...Object.entries(envelope),
    ...Object.entries(data).map(([name, value]) => [`data.${name}`, value] as const),
  ])
}

function sameValue(name: string, a: unknown, b: unknown): boolean {
  if (TIME_FIELDS.has(name) && typeof a === 'string' && typeof b === 'string') {
    return Date.parse(a) === Date.parse(b)
  }
  return isDeepStrictEqual(a, b)
}

/**
 * Compares two copies of an event (same eventId) and returns the names of the
 * fields that differ, sorted; empty means the copies are equal (ADR-0011).
 * receivedAt is ignored, times are compared as instants, the rest exactly.
 */
export function differingFields(a: TrackingEvent, b: TrackingEvent): string[] {
  const fieldsOfA = comparableFields(a)
  const fieldsOfB = comparableFields(b)
  const names = new Set([...fieldsOfA.keys(), ...fieldsOfB.keys()])
  return [...names].filter((name) => !sameValue(name, fieldsOfA.get(name), fieldsOfB.get(name))).sort()
}
