import { wasReceivedEarlier } from './projection.js'
import type { TrackingEvent } from './shipment-status.js'

/** One copy of an event and the message that brought it. */
export type EventCopy = {
  event: TrackingEvent
  subject: string
  streamSequence: number
}

/**
 * Merges two equal copies (differingFields is empty). The content is the copy
 * received earlier, by the same R1 rule as in project(); the position in the
 * stream is the lower one. Independent of the order of the arguments.
 */
export function mergeEqualCopies(a: EventCopy, b: EventCopy): EventCopy {
  const { subject, streamSequence } = b.streamSequence < a.streamSequence ? b : a
  return { event: wasReceivedEarlier(b.event, a.event) ? b.event : a.event, subject, streamSequence }
}
