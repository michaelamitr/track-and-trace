import { connect, type ConnectionOptions, type NatsConnection } from '@nats-io/transport-node'

/**
 * Connects to NATS. `options` are passed to the client; long-running services
 * should set `maxReconnectAttempts: -1`, because the client default (10
 * attempts) gives up for good after a short outage.
 */
export function connectNats(
  url: string = process.env.NATS_URL ?? 'nats://localhost:4222',
  options: Omit<ConnectionOptions, 'servers'> = {},
): Promise<NatsConnection> {
  return connect({ ...options, servers: url })
}
