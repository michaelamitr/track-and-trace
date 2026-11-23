// Integration-test helpers only.
import { createPool, runMigrations } from '@tt/db'
import { startPostgres } from '@tt/db/testing'
import pg from 'pg'
import { pino } from 'pino'
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
  stop(): Promise<void>
}

/** A fresh Postgres with all migrations run as tracking_owner (as `pnpm db:migrate` does). */
export async function startTestDatabase(): Promise<TestDatabase> {
  const postgres = await startPostgres()
  const ownerUrl = postgres.url('tracking_owner', 'tracking_db')
  const serviceUrl = postgres.url('tracking_service', 'tracking_db')
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

export async function clearTables(owner: pg.Pool): Promise<void> {
  await owner.query('TRUNCATE tracking_events, shipment_tracking, tracking_history, quarantined_events')
}

export async function storedEvents(pool: pg.Pool) {
  return (await pool.query('SELECT * FROM tracking_events ORDER BY event_id')).rows
}

export async function quarantinedEvents(pool: pg.Pool) {
  return (await pool.query('SELECT * FROM quarantined_events ORDER BY stream_sequence')).rows
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
