// Integration-test helpers only.
import type { JetStreamClient } from '@nats-io/jetstream'
import { createPool, runMigrations } from '@tt/db'
import { startPostgres } from '@tt/db/testing'
import pg from 'pg'
import { MIGRATIONS_DIR } from './db/migrations.js'
import type { RelayLogger } from './outbox/relay.js'

export type TestDatabase = {
  /** URL of shipment_db for shipment_owner (migrations). */
  ownerUrl: string
  /** URL of shipment_db for shipment_service (data only). */
  serviceUrl: string
  /** The runtime pool, connected as shipment_service. */
  pool: pg.Pool
  /** Connected as shipment_owner, for setup that the service role cannot do. */
  owner: pg.Pool
  stop(): Promise<void>
}

/** A fresh Postgres with all migrations run as shipment_owner (as `pnpm db:migrate` does). */
export async function startTestDatabase(): Promise<TestDatabase> {
  const postgres = await startPostgres()
  const ownerUrl = postgres.url('shipment_owner', 'shipment_db')
  const serviceUrl = postgres.url('shipment_service', 'shipment_db')
  await runMigrations({ databaseUrl: ownerUrl, dir: MIGRATIONS_DIR, direction: 'up', log: () => {} })
  const pool = createPool(serviceUrl)
  const owner = new pg.Pool({ connectionString: ownerUrl })
  return {
    ownerUrl,
    serviceUrl,
    pool,
    owner,
    async stop() {
      await pool.end()
      await owner.end()
      await postgres.stop()
    },
  }
}

export type OutboxRow = {
  event_id: string
  subject: string
  payload: Record<string, unknown>
  published_at: Date | null
}

export async function outboxRows(pool: pg.Pool): Promise<OutboxRow[]> {
  const result = await pool.query<OutboxRow>(
    'SELECT event_id, subject, payload, published_at FROM outbox ORDER BY created_at, event_id',
  )
  return result.rows
}

/** Counts publishes per msgID and can delay or block them; the rest is the real client. */
export function countingJetStream(
  js: JetStreamClient,
  options: { delayMs?: number; before?: (msgID: string) => Promise<void> } = {},
) {
  const counts = new Map<string, number>()
  const client = new Proxy(js, {
    get(target, prop, receiver) {
      if (prop !== 'publish') return Reflect.get(target, prop, receiver)
      return async (...args: Parameters<JetStreamClient['publish']>) => {
        const msgID = args[2]?.msgID ?? '(none)'
        counts.set(msgID, (counts.get(msgID) ?? 0) + 1)
        if (options.before) await options.before(msgID)
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        return target.publish(...args)
      }
    },
  })
  return { js: client, counts }
}

export const quietLog: RelayLogger = { debug() {}, info() {}, warn() {}, error() {} }
