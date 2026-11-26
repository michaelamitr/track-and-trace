// Integration-test helpers only.
import type { LogisticsEvent } from '@tt/contracts'
import { createPool, runMigrations } from '@tt/db'
import { startPostgres, type TestPostgres } from '@tt/db/testing'
import { LOGISTICS_STREAM, publishEvent, type ConsumerTiming } from '@tt/messaging'
import type { TestNats } from '@tt/messaging/testing'
import pg from 'pg'
import { pino } from 'pino'
import { expect, vi } from 'vitest'
import { MIGRATIONS_DIR } from './db/migrations.js'
import type { TrackingProjection } from './domain/projection.js'

export type TestDatabase = {
  /** URL of tracking_db for tracking_owner (migrations). */
  ownerUrl: string
  /** URL of tracking_db for tracking_service (data only). */
  serviceUrl: string
  /** The runtime pool, connected as tracking_service. */
  pool: pg.Pool
  /** Connected as tracking_owner, for setup that the service role cannot do. */
  owner: pg.Pool
  /** The server; stopServer() and startServer() need `restartable`. */
  postgres: TestPostgres
  stop(): Promise<void>
}

/** A fresh Postgres with all migrations run as tracking_owner (as `pnpm db:migrate` does). */
export async function startTestDatabase(options: { restartable?: boolean } = {}): Promise<TestDatabase> {
  const postgres = await startPostgres(options)
  const ownerUrl = postgres.url('tracking_owner', 'tracking_db')
  const serviceUrl = postgres.url('tracking_service', 'tracking_db')
  await runMigrations({ databaseUrl: ownerUrl, dir: MIGRATIONS_DIR, direction: 'up', log: () => {} })
  const pool = createPool(serviceUrl)
  const owner = new pg.Pool({ connectionString: ownerUrl })
  // As in createPool: without a listener stopServer() would crash the test process.
  owner.on('error', () => {})
  return {
    ownerUrl,
    serviceUrl,
    pool,
    owner,
    postgres,
    async stop() {
      await pool.end()
      await owner.end()
      await postgres.stop()
    },
  }
}

/** Short delays of the failure handling (ADR-0015), so a nak'ed message returns quickly in a test. */
export const TEST_TIMING: ConsumerTiming = {
  retryBaseMs: 100,
  retryMaxMs: 400,
  nakDelaysMs: [300, 300, 300, 300],
  workingIntervalMs: 1_000,
  fetchExpiresMs: 1_000,
}

export async function clearTables(owner: pg.Pool): Promise<void> {
  await owner.query('TRUNCATE received_messages, shipment_tracking, tracking_history, tracking_conflicts, quarantined_events')
}

/** Publishes in the given order; every copy is stored, also one with a known eventId (like Scan Ingestion). */
export async function publish(nats: TestNats, ...events: LogisticsEvent[]): Promise<void> {
  for (const event of events) await publishEvent(nats.js, event, { deduplicate: false })
}

/** Waits until every published message is acked; fails if one is dropped or redelivered forever. */
export async function waitUntilAcked(nats: TestNats): Promise<void> {
  const { state } = await nats.jsm.streams.info(LOGISTICS_STREAM.name)
  await vi.waitFor(
    async () => {
      const info = await nats.jsm.consumers.info(LOGISTICS_STREAM.name, 'tracking')
      expect(info.num_ack_pending).toBe(0)
      expect(info.ack_floor.stream_seq).toBe(state.last_seq)
    },
    { timeout: 10_000, interval: 50 },
  )
}

/** Everything received, in stream order. */
export async function receivedMessages(pool: pg.Pool) {
  return (await pool.query('SELECT * FROM received_messages ORDER BY stream_sequence')).rows
}

export async function trackingConflicts(pool: pg.Pool) {
  const result = await pool.query(
    `SELECT shipment_id, event_id, stream_sequence, received_at, differing_fields
       FROM tracking_conflicts ORDER BY stream_sequence, shipment_id`,
  )
  return result.rows
}

export async function quarantinedEvents(pool: pg.Pool) {
  return (await pool.query('SELECT * FROM quarantined_events')).rows
}

/** All of the read model of a shipment except updated_at, or null if it is not known. */
export async function readModel(pool: pg.Pool, shipmentId: string) {
  const state = await pool.query(
    `SELECT tracking_number, status, last_location, last_event_at, delivered_at
       FROM shipment_tracking WHERE shipment_id = $1`,
    [shipmentId],
  )
  const history = await pool.query(
    `SELECT position, event_id, event_type, status, occurred_at, received_at, facility_id, is_anomaly
       FROM tracking_history WHERE shipment_id = $1 ORDER BY position`,
    [shipmentId],
  )
  if (!state.rows[0] && history.rows.length === 0) return null
  return { state: state.rows[0], history: history.rows }
}

/** What readModel() must return for this projection. */
export function expectedReadModel(trackingNumber: string, projection: TrackingProjection) {
  const date = (time: string | null) => (time === null ? null : new Date(time))
  return {
    state: {
      tracking_number: trackingNumber,
      status: projection.status,
      last_location: projection.lastLocation,
      last_event_at: date(projection.lastEventAt),
      delivered_at: date(projection.deliveredAt),
    },
    history: projection.history.map((entry, index) => ({
      position: index + 1,
      event_id: entry.eventId,
      event_type: entry.eventType,
      status: entry.status,
      occurred_at: date(entry.occurredAt),
      received_at: date(entry.receivedAt),
      facility_id: entry.facilityId,
      is_anomaly: entry.isAnomaly,
    })),
  }
}

export type LogLine = Record<string, unknown>

/** A real logger like the one in main.ts whose JSON lines are collected. */
export function memoryLog() {
  const lines: LogLine[] = []
  const log = pino({ base: { service: 'tracking' } }, { write: (line: string) => lines.push(JSON.parse(line)) })
  return { log, lines }
}
