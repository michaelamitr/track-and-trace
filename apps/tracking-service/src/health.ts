import type { NatsConnection } from '@nats-io/transport-node'
import type { HealthCheck } from '@tt/http'
import type pg from 'pg'

export type TrackingHealthChecks = { database: HealthCheck; nats: HealthCheck }

/** A database query works; the NATS connection is up (rtt() throws while disconnected). */
export function createHealthChecks(deps: { pool: pg.Pool; nc: NatsConnection }): TrackingHealthChecks {
  return {
    database: () => deps.pool.query('SELECT 1'),
    nats: () => deps.nc.rtt(),
  }
}
