import type { PublishOptions, PublishResult } from '@tt/messaging'
import { ZodError } from 'zod'
import {
  buildScanEvent,
  isOccurredAtTooFarInFuture,
  MAX_OCCURRED_AT_SKEW_MS,
  normalizeScan,
  type ScanEvent,
  type ScanRequest,
} from '../domain/scan.js'

/** publishEvent bound to a JetStream client (main.ts); tests pass a fake. */
export type PublishScanEvent = (event: ScanEvent, options: PublishOptions) => Promise<PublishResult>

/**
 * Validates, normalizes and publishes one scan; resolves with the published
 * event after the JetStream ack. `receivedAt` is when the request arrived.
 */
export type IngestScan = (scan: ScanRequest, receivedAt: Date) => Promise<ScanEvent>

/** occurredAt is more than MAX_OCCURRED_AT_SKEW_MS after receivedAt (400). */
export class OccurredAtInFutureError extends Error {
  override name = 'OccurredAtInFutureError'
  constructor() {
    super(`occurredAt must not be more than ${MAX_OCCURRED_AT_SKEW_MS / 60_000} minutes in the future.`)
  }
}

/**
 * NATS did not confirm the publish: not connected, timed out, no responders or
 * the stream is missing (503). Carries the event so the failure can be logged.
 * The service does not retry; the scanner retries with the same eventId.
 */
export class PublishFailedError extends Error {
  override name = 'PublishFailedError'
  constructor(
    readonly event: ScanEvent,
    options: { cause: unknown },
  ) {
    super('The event could not be published.', options)
  }
}

export function createIngestScan(deps: { publish: PublishScanEvent }): IngestScan {
  return async (request, receivedAt) => {
    const scan = normalizeScan(request)
    if (isOccurredAtTooFarInFuture(scan.occurredAt, receivedAt)) throw new OccurredAtInFutureError()

    const event = buildScanEvent(scan, receivedAt)
    try {
      // No Nats-Msg-Id: every copy reaches the consumers, which deduplicate by eventId (ADR-0010).
      await deps.publish(event, { deduplicate: false })
    } catch (err) {
      // An event that fails its own contract is a bug (500), not an outage; retrying would not help.
      if (err instanceof ZodError) throw err
      throw new PublishFailedError(event, { cause: err })
    }
    return event
  }
}
