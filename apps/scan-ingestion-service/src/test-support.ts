// Integration-test helpers only.
import type { JetStreamManager } from '@nats-io/jetstream'
import { LOGISTICS_STREAM } from '@tt/messaging'

export type StreamMessage = { seq: number; subject: string; msgId: string | undefined; event: Record<string, unknown> }

/** Every message in LOGISTICS_EVENTS, oldest first. */
export async function streamMessages(jsm: JetStreamManager): Promise<StreamMessage[]> {
  const info = await jsm.streams.info(LOGISTICS_STREAM.name)
  const messages: StreamMessage[] = []
  for (let seq = info.state.first_seq; seq <= info.state.last_seq && info.state.messages > 0; seq++) {
    const msg = await jsm.streams.getMessage(LOGISTICS_STREAM.name, { seq })
    if (!msg) continue
    messages.push({
      seq,
      subject: msg.subject,
      msgId: msg.header?.get('Nats-Msg-Id') || undefined,
      event: msg.json<Record<string, unknown>>(),
    })
  }
  return messages
}
