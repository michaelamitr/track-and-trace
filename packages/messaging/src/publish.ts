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
}

/**
 * Validates and publishes an event. An invalid event throws and nothing is
 * published. msgID = eventId, so a retried publish within the stream's
 * duplicate_window is stored once and acknowledged with duplicate: true.
 */
export async function publishEvent(
  js: JetStreamClient,
  event: unknown,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const valid = LogisticsEventSchema.parse(event)
  const ack = await js.publish(options.subject ?? subjectForEvent(valid), JSON.stringify(valid), {
    msgID: valid.eventId,
  })
  return { seq: ack.seq, duplicate: ack.duplicate }
}
