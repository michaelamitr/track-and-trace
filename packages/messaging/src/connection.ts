import { connect, type NatsConnection } from '@nats-io/transport-node'

export function connectNats(
  url: string = process.env.NATS_URL ?? 'nats://localhost:4222',
): Promise<NatsConnection> {
  return connect({ servers: url })
}
