import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import { connectNats, publishEvent, verifyStream } from '@tt/messaging'
import { pino } from 'pino'
import { createIngestScan } from './application/ingest-scan.js'
import { loadConfig } from './config.js'
import { createReadinessCheck } from './health.js'
import { buildApp } from './http/app.js'

// Structured JSON logs. Config values are never logged.
const log = pino({ base: { service: 'scan-ingestion' } })

let nc: NatsConnection | undefined

try {
  const config = loadConfig()

  nc = await connectNats(config.natsUrl, {
    name: 'scan-ingestion-service',
    // Never give up reconnecting; scans get 503 while NATS is down and succeed once it is back.
    maxReconnectAttempts: -1,
  })
  await verifyStream(await jetstreamManager(nc))
  const js = jetstream(nc)

  const app = await buildApp({
    ingestScan: createIngestScan({ publish: (event, options) => publishEvent(js, event, options) }),
    checkReadiness: createReadinessCheck({ nc }),
    logger: log,
  })

  const openNc = nc
  app.addHook('onClose', async () => {
    await openNc.drain()
  })

  let closing = false
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return
    closing = true
    log.info({ signal }, 'shutting down')
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error({ err }, 'shutdown failed')
        process.exit(1)
      },
    )
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  await app.listen({ port: config.port, host: config.host })
} catch (err) {
  // Fail fast: a service that cannot reach NATS or whose stream is missing must not start.
  log.fatal({ err }, 'startup failed')
  await nc?.close().catch(() => {})
  process.exit(1)
}
