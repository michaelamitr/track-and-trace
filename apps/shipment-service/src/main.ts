import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import { createPool, verifyNoPendingMigrations } from '@tt/db'
import { cleanUpAfterFailedStart, runShutdown } from '@tt/lifecycle'
import type { FastifyInstance } from 'fastify'
import { closeNats, connectNats, verifyStream } from '@tt/messaging'
import type pg from 'pg'
import { pino } from 'pino'
import { createGetShipment } from './application/get-shipment.js'
import { createRegisterShipment } from './application/register-shipment.js'
import { loadConfig } from './config.js'
import { MIGRATIONS_DIR } from './db/migrations.js'
import { createHealthChecks } from './health.js'
import { buildApp } from './http/app.js'
import { startOutboxRelay, type OutboxRelay } from './outbox/relay.js'

// Structured JSON logs. Config values are never logged: the database URL contains a password.
const log = pino({ base: { service: 'shipment' } })

let pool: pg.Pool | undefined
let nc: NatsConnection | undefined
let app: FastifyInstance | undefined
let relay: OutboxRelay | undefined

try {
  const config = loadConfig()

  pool = createPool(config.databaseUrl, log)
  await verifyNoPendingMigrations(pool, MIGRATIONS_DIR)

  nc = await connectNats(config.natsUrl, {
    name: 'shipment-service',
    // Never give up reconnecting; the outbox relay retries until NATS is back.
    maxReconnectAttempts: -1,
  })
  await verifyStream(await jetstreamManager(nc))
  const js = jetstream(nc)

  const httpApp = await buildApp({
    registerShipment: createRegisterShipment({ pool }),
    getShipment: createGetShipment({ pool }),
    checks: createHealthChecks({ pool, nc }),
    logger: log,
  })

  app = httpApp
  const runningRelay = startOutboxRelay({ pool, js, log: log.child({ component: 'outbox-relay' }) })
  relay = runningRelay

  const openPool = pool
  const openNc = nc
  let closing = false
  // ADR-0015 rule 5: the relay first, so its round can commit while the database and NATS are open.
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return
    closing = true
    log.info({ signal }, 'shutting down')
    void runShutdown(
      [
        { name: 'outbox relay', run: () => runningRelay.stop() },
        { name: 'http', run: () => httpApp.close() },
        { name: 'nats', run: () => closeNats(openNc, { log }) },
        { name: 'pool', run: () => openPool.end() },
      ],
      { log },
    ).then((code) => process.exit(code))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  await httpApp.listen({ port: config.port, host: config.host })
} catch (err) {
  // Fail fast: a service that cannot reach its dependencies or whose schema is
  // out of date must not start.
  log.fatal({ err }, 'startup failed')
  // Close what was already opened, under the same deadline as a shutdown (ADR-0015 rule 5).
  const opened = { relay, app, nc, pool }
  const code = await cleanUpAfterFailedStart(
    [
      { name: 'outbox relay', run: async () => opened.relay?.stop() },
      { name: 'http', run: async () => opened.app?.close() },
      { name: 'nats', run: async () => opened.nc && closeNats(opened.nc, { log }) },
      { name: 'pool', run: async () => opened.pool?.end() },
    ],
    { log },
  )
  process.exit(code)
}
