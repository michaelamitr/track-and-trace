import { differingFields } from './compare-copies.js'
import { wasReceivedEarlier } from './projection.js'
import type { TrackingEvent } from './shipment-status.js'

/** One received message: one copy of an event. */
export type StoredCopy = {
  streamSequence: number
  eventId: string
  shipmentId: string
  event: TrackingEvent
}

export type Conflict = {
  eventId: string
  /** Both of the copy that differs from the kept one. */
  streamSequence: number
  receivedAt: string
  differingFields: string[]
  /** The shipment of the kept copy and, if it is another one, of this copy. */
  shipmentIds: string[]
}

export type ResolvedEvent = {
  /** The kept copy. Its event has the earliest receivedAt of all equal copies (R1). */
  kept: StoredCopy
  /** Stream sequences of the other copies that are equal to the kept one. */
  duplicates: number[]
  conflicts: Conflict[]
}

function resolveEvent([kept, ...others]: [StoredCopy, ...StoredCopy[]]): ResolvedEvent {
  const resolved: ResolvedEvent = { kept, duplicates: [], conflicts: [] }
  for (const copy of others) {
    const fields = differingFields(kept.event, copy.event)
    if (fields.length > 0) {
      resolved.conflicts.push({
        eventId: kept.eventId,
        streamSequence: copy.streamSequence,
        receivedAt: copy.event.receivedAt,
        differingFields: fields,
        shipmentIds: [...new Set([kept.shipmentId, copy.shipmentId])],
      })
      continue
    }
    resolved.duplicates.push(copy.streamSequence)
    if (wasReceivedEarlier(copy.event, resolved.kept.event)) {
      const event = { ...kept.event, receivedAt: copy.event.receivedAt }
      resolved.kept = { ...kept, event }
    }
  }
  return resolved
}

/**
 * Decides which copy of each event counts (ADR-0014): the one with the lowest
 * stream sequence. Depends only on which copies exist, never on their order.
 * Returns the resolved events by eventId.
 */
export function resolveCopies(copies: StoredCopy[]): Map<string, ResolvedEvent> {
  const copiesById = new Map<string, [StoredCopy, ...StoredCopy[]]>()
  for (const copy of copies.toSorted((a, b) => a.streamSequence - b.streamSequence)) {
    const known = copiesById.get(copy.eventId)
    if (known) known.push(copy)
    else copiesById.set(copy.eventId, [copy])
  }
  return new Map([...copiesById].map(([eventId, group]) => [eventId, resolveEvent(group)]))
}

export type MessageOutcome = 'new' | 'duplicate' | 'conflict'

/**
 * What a message was for its event. `isNewMessage` is false for a redelivery.
 * A kept copy that arrives after a different one reveals the conflict.
 */
export function messageOutcome(
  resolved: ResolvedEvent,
  streamSequence: number,
  isNewMessage: boolean,
): MessageOutcome {
  if (resolved.conflicts.some((conflict) => conflict.streamSequence === streamSequence)) return 'conflict'
  if (resolved.kept.streamSequence !== streamSequence || !isNewMessage) return 'duplicate'
  if (resolved.conflicts.length > 0) return 'conflict'
  return resolved.duplicates.length > 0 ? 'duplicate' : 'new'
}

/** True if the message is one of the copies of the event. */
export function hasCopy(resolved: ResolvedEvent, streamSequence: number): boolean {
  return (
    resolved.kept.streamSequence === streamSequence ||
    resolved.duplicates.includes(streamSequence) ||
    resolved.conflicts.some((conflict) => conflict.streamSequence === streamSequence)
  )
}
