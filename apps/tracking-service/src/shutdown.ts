import { runShutdown, type ShutdownLogger } from '@tt/lifecycle'
import { closeNats, type CloseLogger } from '@tt/messaging'
import type { NatsConnection } from '@nats-io/transport-node'

export type ShutdownDeps = {
  consumer: { stop(): Promise<void> }
  app: { close(): Promise<unknown> }
  nc: NatsConnection
  pool: { end(): Promise<void> }
}

/**
 * Stops the service in order within the deadline (ADR-0015 rule 5) and resolves
 * to the exit code. Consuming stops first, while the database and NATS are
 * still open, so the message in progress can commit and be acked; a message
 * waiting for the database is naked instead.
 */
export function shutdown(deps: ShutdownDeps, log: ShutdownLogger & CloseLogger, deadlineMs?: number): Promise<number> {
  return runShutdown(
    [
      { name: 'consumer', run: () => deps.consumer.stop() },
      { name: 'http', run: () => deps.app.close() },
      { name: 'nats', run: () => closeNats(deps.nc, { log }) },
      { name: 'pool', run: () => deps.pool.end() },
    ],
    { log, ...(deadlineMs === undefined ? {} : { deadlineMs }) },
  )
}
