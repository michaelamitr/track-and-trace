import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import { createPool, verifyNoPendingMigrations } from '@tt/db'
import { connectNats, consumeEvents, verifyConsumer, verifyStream, type ConsumeHandle } from '@tt/messaging'
import type pg from 'pg'
import { pino } from 'pino'
import { createEventHandler } from './application/handle-event.js'
import { createProcessEvent } from './application/process-event.js'
import { createGetAnomalies, createGetHistory, createGetTracking } from './application/read-tracking.js'
import { loadConfig } from './config.js'
import { MIGRATIONS_DIR } from './db/migrations.js'
import { createHealthChecks } from './health.js'
import { buildApp } from './http/app.js'
import { shutdown } from './shutdown.js'

// Structured JSON logs. Config values are never logged: the database URL contains a password.
const log = pino({ base: { service: 'tracking' } })

let pool: pg.Pool | undefined
let nc: NatsConnection | undefined
let consumer: ConsumeHandle | undefined

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

  const app = await buildApp({
    getTracking: createGetTracking({ pool }),
    getHistory: createGetHistory({ pool }),
    getAnomalies: createGetAnomalies({ pool }),
    checks: createHealthChecks({ pool, nc }),
    logger: log,
  })

  const handler = createEventHandler({ processEvent: createProcessEvent({ pool }), log })
  consumer = await consumeEvents(jetstream(nc), 'tracking', handler)

  const running = { consumer, app, nc, pool }
  let closing = false
  const onSignal = (signal: NodeJS.Signals) => {
    if (closing) return
    closing = true
    log.info({ signal }, 'shutting down')
    shutdown(running).then(
      () => process.exit(0),
      (err: unknown) => {
        log.error({ err }, 'shutdown failed')
        process.exit(1)
      },
    )
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  await app.listen({ port: config.port, host: config.host })
} catch (err) {
  // Fail fast: a service that cannot reach its dependencies or whose schema is
  // out of date must not start.
  log.fatal({ err }, 'startup failed')
  await consumer?.stop().catch(() => {})
  await nc?.close().catch(() => {})
  await pool?.end().catch(() => {})
  process.exit(1)
}
