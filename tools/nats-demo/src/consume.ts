import { jetstream } from '@nats-io/jetstream'
import type { LogisticsEvent } from '@tt/contracts'
import { connectNats, consumeEvents } from '@tt/messaging'

const MODES = ['ok', 'fail', 'hang'] as const
type Mode = (typeof MODES)[number]

const mode = (process.env.MODE ?? 'ok') as Mode
if (!MODES.includes(mode)) {
  console.error(`MODE must be one of ${MODES.join(', ')}, got "${mode}"`)
  process.exit(1)
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8) // HH:MM:SS, local time
}

async function handler(event: LogisticsEvent): Promise<void> {
  console.log(`[${timestamp()}] received ${event.eventType} ${event.eventId} (MODE=${mode})`)
  if (mode === 'fail') throw new Error('MODE=fail')
  // Never settles: the message is neither acked nor nakked, so the server
  // redelivers it after ack_wait (like a crash before the ack).
  if (mode === 'hang') await new Promise<never>(() => {})
}

const nc = await connectNats()
const handle = await consumeEvents(jetstream(nc), 'tracking', handler)
console.log(`consuming from "tracking" with MODE=${mode}, Ctrl+C to stop`)

let stopping = false
process.on('SIGINT', async () => {
  if (stopping) process.exit(1) // second Ctrl+C forces exit
  stopping = true
  console.log('stopping...')
  // In hang mode the handler never settles, so stop() would wait forever.
  // Give it a moment, then close the connection anyway.
  await Promise.race([handle.stop(), new Promise((r) => setTimeout(r, 2000))])
  await nc.close()
  process.exit(0)
})
