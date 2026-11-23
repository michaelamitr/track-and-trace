import type { EventHandler } from '@tt/messaging'
import { isTrackingEvent } from '../domain/shipment-status.js'
import type { ProcessEvent } from './process-event.js'

export type HandlerLogger = {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

/**
 * The handler of the "tracking" consumer: processes the event and writes one
 * structured log line. `service` is added by the logger. If processing fails
 * it throws, so the message is redelivered.
 */
export function createEventHandler(deps: { processEvent: ProcessEvent; log: HandlerLogger }): EventHandler {
  return async function handleEvent(event, metadata) {
    if (!isTrackingEvent(event)) {
      // The consumer's filter subjects exclude it: a producer used a wrong subject.
      throw new Error(`Unexpected ${event.eventType} on ${metadata.subject}`)
    }
    const result = await deps.processEvent(event, metadata)

    const fields = {
      eventId: event.eventId,
      eventType: event.eventType,
      shipmentId: event.shipmentId,
      correlationId: event.correlationId,
      streamSequence: metadata.streamSequence,
      result,
    }
    if (result === 'conflict') deps.log.warn(fields, 'conflicting copies, one quarantined')
    else deps.log.info(fields, 'event handled')
  }
}
