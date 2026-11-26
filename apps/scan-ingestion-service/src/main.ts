import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import { cleanUpAfterFailedStart, runShutdown } from '@tt/lifecycle'
import type { FastifyInstance } from 'fastify'
import { closeNats, connectNats, publishEvent, verifyStream } from '@tt/messaging'
import { pino } from 'pino'
import { createIngestScan } from './application/ingest-scan.js'
import { loadConfig } from './config.js'
import { createHealthChecks } from './health.js'
import { buildApp } from './http/app.js'

// Structured JSON logs. Config values are never logged.
const log = pino({ base: { service: 'scan-ingestion' } })

let nc: NatsConnection | undefined
let app: FastifyInstance | undefined

try {
  const config = loadConfig()

  nc = await connectNats(config.natsUrl, {
    name: 'scan-ingestion-service',
    // Never give up reconnecting; scans get 503 while NATS is down and succeed once it is back.
    maxReconnectAttempts: -1,
  })
  await verifyStream(await jetstreamManager(nc))
  const js = jetstream(nc)

  const httpApp = await buildApp({
    ingestScan: createIngestScan({ publish: (event, options) => publishEvent(js, event, options) }),
    checks: createHealthChecks({ nc }),
    logger: log,
  })

  const openNc = nc
  let closing = false
  // ADR-0015 rule 5: HTTP first, so requests in progress can still publish.
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return
    closing = true
    log.info({ signal }, 'shutting down')
    void runShutdown(
      [
        { name: 'http', run: () => httpApp.close() },
        { name: 'nats', run: () => closeNats(openNc, { log }) },
      ],
      { log },
    ).then((code) => process.exit(code))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  app = httpApp
  await httpApp.listen({ port: config.port, host: config.host })
} catch (err) {
  // Fail fast: a service that cannot reach NATS or whose stream is missing must not start.
  log.fatal({ err }, 'startup failed')
  // Close what was already opened, under the same deadline as a shutdown (ADR-0015 rule 5).
  const opened = { app, nc }
  const code = await cleanUpAfterFailedStart(
    [
      { name: 'http', run: async () => opened.app?.close() },
      { name: 'nats', run: async () => opened.nc && closeNats(opened.nc, { log }) },
    ],
    { log },
  )
  process.exit(code)
}
