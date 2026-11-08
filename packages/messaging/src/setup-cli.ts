import { jetstreamManager } from '@nats-io/jetstream'
import { connectNats } from './connection.js'
import { CONSUMERS } from './consumers.js'
import { setupNats } from './setup.js'
import { LOGISTICS_STREAM } from './stream.js'

try {
  const nc = await connectNats()
  try {
    await setupNats(await jetstreamManager(nc))
    console.log(`stream: ${LOGISTICS_STREAM.name}`)
    console.log(`consumers: ${Object.keys(CONSUMERS).join(', ')}`)
  } finally {
    await nc.close()
  }
} catch (err) {
  console.error('NATS setup failed:', err)
  process.exit(1)
}
