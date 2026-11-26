import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import { createPool, verifyNoPendingMigrations } from '@tt/db'
import { cleanUpAfterFailedStart } from '@tt/lifecycle'
import { closeNats, connectNats, verifyConsumer, verifyStream, type ConsumeHandle } from '@tt/messaging'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { pino } from 'pino'
import { createListQuarantine } from './application/quarantine.js'
import { createGetAnomalies, createGetHistory, createGetTracking } from './application/read-tracking.js'
import { loadConfig } from './config.js'
import { startTrackingConsumer } from './consumer.js'
import { MIGRATIONS_DIR } from './db/migrations.js'
import { createHealthChecks } from './health.js'
import { buildApp } from './http/app.js'
import { shutdown } from './shutdown.js'

// Structured JSON logs. Config values are never logged: the database URL contains a password.
const log = pino({ base: { service: 'tracking' } })

let pool: pg.Pool | undefined
let nc: NatsConnection | undefined
let consumer: ConsumeHandle | undefined
let app: FastifyInstance | undefined

try {
  const config = loadConfig()

  pool = createPool(config.databaseUrl, log)
  await verifyNoPendingMigrations(pool, MIGRATIONS_DIR)

  nc = await connectNats(config.natsUrl, {
    name: 'tracking-service',
    // Never give up reconnecting; consuming continues once NATS is back.
    maxReconnectAttempts: -1,
  })
  const jsm = await jetstreamManager(nc)
  await verifyStream(jsm)
  await verifyConsumer(jsm, 'tracking')

  app = await buildApp({
    getTracking: createGetTracking({ pool }),
    getHistory: createGetHistory({ pool }),
    getAnomalies: createGetAnomalies({ pool }),
    listQuarantine: createListQuarantine({ pool }),
    checks: createHealthChecks({ pool, nc }),
    logger: log,
  })

  consumer = await startTrackingConsumer({ js: jetstream(nc), pool, log })

  const running = { consumer, app, nc, pool }
  let closing = false
  const onSignal = (signal: NodeJS.Signals) => {
    if (closing) return
    closing = true
    log.info({ signal }, 'shutting down')
    void shutdown(running, log).then((code) => process.exit(code))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  await app.listen({ port: config.port, host: config.host })
} catch (err) {
  // Fail fast: a service that cannot reach its dependencies or whose schema is
  // out of date must not start.
  log.fatal({ err }, 'startup failed')
  // Close what was already opened, under the same deadline as a shutdown (ADR-0015 rule 5).
  const opened = { consumer, app, nc, pool }
  const code = await cleanUpAfterFailedStart(
    [
      { name: 'consumer', run: async () => opened.consumer?.stop() },
      { name: 'http', run: async () => opened.app?.close() },
      { name: 'nats', run: async () => opened.nc && closeNats(opened.nc, { log }) },
      { name: 'pool', run: async () => opened.pool?.end() },
    ],
    { log },
  )
  process.exit(code)
}
