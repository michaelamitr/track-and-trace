import type { JetStreamClient } from '@nats-io/jetstream'
import { publishEvent } from '@tt/messaging'
import type pg from 'pg'

export type RelayLogger = {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export type OutboxRelayOptions = {
  pool: pg.Pool
  js: JetStreamClient
  /** Pause between rounds when the outbox is drained. */
  intervalMs?: number
  /** Rows published per round (and per transaction). */
  batchSize?: number
  /** Upper limit of the pause after failed rounds (exponential backoff). */
  maxBackoffMs?: number
  log: RelayLogger
}

export type OutboxRelay = {
  /** Lets the current round finish (commit or rollback), then stops. */
  stop(): Promise<void>
}

type OutboxRow = { event_id: string; payload: unknown }

/**
 * Publishes one batch of unpublished outbox rows. Returns the number of rows
 * published; throws (after ROLLBACK) if publishing or the database fails.
 *
 * Trade-off: the selected rows stay locked while we wait for the NATS ack of
 * each event. That keeps the round simple (lock, publish, mark, commit) and
 * guarantees that two relays never publish the same row, at the cost of
 * holding row locks and a database connection for the duration of the
 * publishes. Acceptable for small batches; nothing else updates outbox rows.
 * If the commit fails after a successful publish, the rows are published again
 * in a later round; Nats-Msg-Id (= eventId) and the consumers' inbox drop the
 * copy (at-least-once).
 */
export async function publishOutboxBatch(
  pool: pg.Pool,
  js: JetStreamClient,
  batchSize: number,
): Promise<number> {
  const client = await pool.connect()
  let broken: Error | undefined
  try {
    await client.query('BEGIN')
    // SKIP LOCKED: rows locked by another relay instance are left to it
    // instead of blocking this one.
    const { rows } = await client.query<OutboxRow>(
      `SELECT event_id, payload
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    )
    for (const row of rows) {
      // Waits for the JetStream ack; msgID = eventId (ADR-0006).
      await publishEvent(js, row.payload)
    }
    if (rows.length > 0) {
      await client.query(`UPDATE outbox SET published_at = now() WHERE event_id = ANY($1::uuid[])`, [
        rows.map((row) => row.event_id),
      ])
    }
    await client.query('COMMIT')
    return rows.length
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr))
    }
    throw err
  } finally {
    client.release(broken)
  }
}

/**
 * Runs the outbox relay inside the service process: polls the outbox about
 * every intervalMs and publishes unpublished rows in order of creation. After
 * a failed round (NATS or database down) it retries with capped exponential
 * backoff.
 */
export function startOutboxRelay(options: OutboxRelayOptions): OutboxRelay {
  const { pool, js, log } = options
  const intervalMs = options.intervalMs ?? 1_000
  const batchSize = options.batchSize ?? 50
  const maxBackoffMs = options.maxBackoffMs ?? 30_000

  let stopping = false
  let wake: (() => void) | undefined

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        wake = undefined
        resolve()
      }
      wake = done
    })
  }

  async function run(): Promise<void> {
    let failures = 0
    while (!stopping) {
      let published = 0
      try {
        published = await publishOutboxBatch(pool, js, batchSize)
        if (failures > 0) log.info({ failures }, 'outbox relay recovered')
        failures = 0
        if (published > 0) log.debug({ published }, 'outbox events published')
      } catch (err) {
        failures += 1
        const delayMs = Math.min(intervalMs * 2 ** (failures - 1), maxBackoffMs)
        log.warn({ err, failures, retryInMs: delayMs }, 'outbox relay round failed, will retry')
        if (!stopping) await pause(delayMs)
        continue
      }
      // A full batch means more rows may be waiting: continue without a pause.
      if (published < batchSize && !stopping) await pause(intervalMs)
    }
  }

  const running = run().catch((err: unknown) => {
    // run() handles round errors itself; this is a bug guard.
    log.error({ err }, 'outbox relay stopped unexpectedly')
  })

  return {
    async stop() {
      stopping = true
      wake?.()
      await running
    },
  }
}
