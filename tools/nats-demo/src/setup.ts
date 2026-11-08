import { jetstreamManager } from '@nats-io/jetstream'
import { connectNats, ensureConsumer, ensureStream } from '@tt/messaging'

const nc = await connectNats()
try {
  const jsm = await jetstreamManager(nc)
  await ensureStream(jsm)
  await ensureConsumer(jsm, 'tracking')
  console.log('stream and consumer ready')
} finally {
  await nc.close()
}
