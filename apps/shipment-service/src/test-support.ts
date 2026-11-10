// Integration-test helpers only.
import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream'
import { LOGISTICS_STREAM } from '@tt/messaging'
import pg from 'pg'
import { runMigrations } from './db/migrations.js'
import { createPool } from './db/pool.js'
import { startPostgres, type TestPostgres } from './db/test-postgres.js'
import type { RelayLogger } from './outbox/relay.js'

export type TestDatabase = {
  postgres: TestPostgres
  /** The runtime pool, connected as shipment_service. */
  pool: pg.Pool
  /** Connected as shipment_owner, for setup that the service role cannot do. */
  owner: pg.Pool
  stop(): Promise<void>
}

/** A fresh Postgres with all migrations run as shipment_owner (as `pnpm db:migrate` does). */
export async function startTestDatabase(): Promise<TestDatabase> {
  const postgres = await startPostgres()
  await runMigrations({ databaseUrl: postgres.ownerUrl, direction: 'up', log: () => {} })
  const pool = createPool(postgres.serviceUrl)
  const owner = new pg.Pool({ connectionString: postgres.ownerUrl })
  return {
    postgres,
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

export type StreamMessage = { seq: number; subject: string; msgId: string | undefined; event: Record<string, unknown> }

/** Every message in LOGISTICS_EVENTS, oldest first. */
export async function streamMessages(jsm: JetStreamManager): Promise<StreamMessage[]> {
  const info = await jsm.streams.info(LOGISTICS_STREAM.name)
  const messages: StreamMessage[] = []
  for (let seq = info.state.first_seq; seq <= info.state.last_seq && info.state.messages > 0; seq++) {
    const msg = await jsm.streams.getMessage(LOGISTICS_STREAM.name, { seq })
    if (!msg) continue
    messages.push({
      seq,
      subject: msg.subject,
      msgId: msg.header?.get('Nats-Msg-Id') || undefined,
      event: msg.json<Record<string, unknown>>(),
    })
  }
  return messages
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
