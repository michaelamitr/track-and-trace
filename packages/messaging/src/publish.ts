import type { JetStreamClient } from '@nats-io/jetstream'
import { LogisticsEventSchema, subjectForEvent } from '@tt/contracts'

export type PublishResult = { seq: number; duplicate: boolean }

/**
 * Validates and publishes an event. An invalid event throws and nothing is
 * published. msgID = eventId, so a retried publish within the stream's
 * duplicate_window is stored once and acknowledged with duplicate: true.
 */
export async function publishEvent(
  js: JetStreamClient,
  event: unknown,
): Promise<PublishResult> {
  const valid = LogisticsEventSchema.parse(event)
  const ack = await js.publish(subjectForEvent(valid), JSON.stringify(valid), {
    msgID: valid.eventId,
  })
  return { seq: ack.seq, duplicate: ack.duplicate }
}
