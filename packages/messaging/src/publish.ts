import type { JetStreamClient } from '@nats-io/jetstream'
import { LogisticsEventSchema, subjectForEvent } from '@tt/contracts'

export type PublishResult = { seq: number; duplicate: boolean }

export type PublishOptions = {
  /**
   * Subject to publish to. Defaults to subjectForEvent(event). The outbox
   * relay passes the subject stored with the row, so a queued event keeps
   * its subject even if the subject rules change later.
   */
  subject?: string
  /**
   * true (default): msgID = eventId, so JetStream stores a retried publish
   * within the stream's duplicate_window once and acks it with
   * duplicate: true. The Shipment Service relies on this (ADR-0006).
   *
   * false: no msgID, so the message has no Nats-Msg-Id header and every
   * publish is stored, even with an eventId seen before. Used by Scan
   * Ingestion, whose eventIds come from scanners (ADR-0010); consumers
   * deduplicate by eventId instead.
   */
  deduplicate?: boolean
}

/**
 * Validates and publishes an event and resolves after the JetStream ack. An
 * invalid event throws and nothing is published. Whether JetStream
 * deduplicates by eventId is set by `options.deduplicate` (default true).
 */
export async function publishEvent(
  js: JetStreamClient,
  event: unknown,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const valid = LogisticsEventSchema.parse(event)
  const deduplicate = options.deduplicate ?? true
  const ack = await js.publish(
    options.subject ?? subjectForEvent(valid),
    JSON.stringify(valid),
    deduplicate ? { msgID: valid.eventId } : undefined,
  )
  return { seq: ack.seq, duplicate: ack.duplicate }
}
