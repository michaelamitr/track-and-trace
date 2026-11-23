import type { NatsConnection } from '@nats-io/transport-node'
import type { HealthCheck } from '@tt/http'

export type ScanIngestionHealthChecks = { nats: HealthCheck }

/** The NATS connection is up (rtt() throws while disconnected). No database. */
export function createHealthChecks(deps: { nc: NatsConnection }): ScanIngestionHealthChecks {
  return { nats: () => deps.nc.rtt() }
}
