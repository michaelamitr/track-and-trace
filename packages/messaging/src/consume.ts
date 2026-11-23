import type { JetStreamClient, JsMsg } from '@nats-io/jetstream'
import { LogisticsEventSchema, type LogisticsEvent } from '@tt/contracts'
import type { ConsumerName } from './consumers.js'
import { LOGISTICS_STREAM } from './stream.js'

/** Where a message comes from; not part of the event itself. */
export type MessageMetadata = {
  /** Position in the stream: the same for every redelivery of a message, unique per published copy. */
  streamSequence: number
  subject: string
  /** 1 for the first delivery to this consumer, higher for redeliveries. */
  deliveryCount: number
}

/**
 * The handler must commit its database transaction before it resolves,
 * because the message is acked right after it resolves. Throwing leads to a
 * nak and a redelivery, so the handler must be idempotent by eventId.
 */
export type EventHandler = (event: LogisticsEvent, metadata: MessageMetadata) => Promise<void>

export type ConsumeHandle = { stop(): Promise<void> }

function parseEvent(msg: JsMsg): LogisticsEvent | undefined {
  let json: unknown
  try {
    json = JSON.parse(msg.string())
  } catch {
    return undefined
  }
  const result = LogisticsEventSchema.safeParse(json)
  return result.success ? result.data : undefined
}

/** Applies the ack rules to one message. Exported for unit tests. */
export async function handleMessage(msg: JsMsg, handler: EventHandler): Promise<void> {
  const event = parseEvent(msg)
  if (!event) {
    // Redelivery cannot fix an invalid message, so it is terminated.
    console.warn(
      `[messaging] invalid message on ${msg.subject} (stream seq ${msg.info.streamSequence}), terminated`,
    )
    msg.term('invalid message')
    return
  }

  try {
    await handler(event, {
      streamSequence: msg.info.streamSequence,
      subject: msg.subject,
      deliveryCount: msg.info.deliveryCount,
    })
  } catch (err) {
    console.error(
      `[messaging] handler failed for ${event.eventId} (stream seq ${msg.info.streamSequence}), nak`,
      err,
    )
    msg.nak()
    return
  }
  msg.ack()
}

/**
 * Pulls messages from a durable consumer (created with ensureConsumer) and
 * processes them one at a time.
 */
export async function consumeEvents(
  js: JetStreamClient,
  consumerName: ConsumerName,
  handler: EventHandler,
): Promise<ConsumeHandle> {
  const consumer = await js.consumers.get(LOGISTICS_STREAM.name, consumerName)
  const messages = await consumer.consume()

  const loop = (async () => {
    for await (const msg of messages) {
      await handleMessage(msg, handler)
    }
  })()

  return {
    async stop() {
      await messages.close()
      await loop
    },
  }
}
