import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import { connectNats, verifyStream } from '@tt/messaging'
import type pg from 'pg'
import { pino } from 'pino'
import { createGetShipment } from './application/get-shipment.js'
import { createRegisterShipment } from './application/register-shipment.js'
import { loadConfig } from './config.js'
import { createPool } from './db/pool.js'
import { verifyNoPendingMigrations } from './db/verify-migrations.js'
import { createReadinessCheck } from './health.js'
import { buildApp } from './http/app.js'
import { startOutboxRelay } from './outbox/relay.js'

// Structured JSON logs. Config values are never logged: the database URL contains a password.
const log = pino({ base: { service: 'shipment' } })

let pool: pg.Pool | undefined
let nc: NatsConnection | undefined

try {
  const config = loadConfig()

  pool = createPool(config.databaseUrl, log)
  await verifyNoPendingMigrations(pool)

  nc = await connectNats(config.natsUrl, {
    name: 'shipment-service',
    // Never give up reconnecting; the outbox relay retries until NATS is back.
    maxReconnectAttempts: -1,
  })
  await verifyStream(await jetstreamManager(nc))
  const js = jetstream(nc)

  const app = await buildApp({
    registerShipment: createRegisterShipment({ pool }),
    getShipment: createGetShipment({ pool }),
    checkReadiness: createReadinessCheck({ pool, nc }),
    logger: log,
  })

  const relay = startOutboxRelay({ pool, js, log: log.child({ component: 'outbox-relay' }) })

  const openPool = pool
  const openNc = nc
  app.addHook('onClose', async () => {
    await relay.stop()
    await openNc.drain()
    await openPool.end()
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
  // Fail fast: a service that cannot reach its dependencies or whose schema is
  // out of date must not start.
  log.fatal({ err }, 'startup failed')
  await nc?.close().catch(() => {})
  await pool?.end().catch(() => {})
  process.exit(1)
}
