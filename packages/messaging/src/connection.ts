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

export type CloseLogger = { warn(obj: object, msg?: string): void }

/**
 * Closes the connection for a shutdown and never rejects. Tries drain() first,
 * so pending messages are flushed; if NATS is unavailable drain() fails or
 * waits for the reconnect, so after `drainTimeoutMs` the connection is closed
 * without it (ADR-0015 rule 5).
 */
export async function closeNats(
  nc: NatsConnection,
  options: { log?: CloseLogger; drainTimeoutMs?: number } = {},
): Promise<void> {
  if (nc.isClosed()) return
  const drainTimeoutMs = options.drainTimeoutMs ?? 2_000
  let timer: NodeJS.Timeout | undefined
  try {
    const drained = nc.drain()
    // Settled later by close() when the timeout wins; must not be unhandled.
    drained.catch(() => {})
    await Promise.race([
      drained,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`NATS drain did not finish within ${drainTimeoutMs} ms`)), drainTimeoutMs)
      }),
    ])
  } catch (err) {
    options.log?.warn({ err }, 'NATS drain failed, closing the connection')
    try {
      await nc.close()
    } catch (closeErr) {
      options.log?.warn({ err: closeErr }, 'closing the NATS connection failed')
    }
  } finally {
    clearTimeout(timer)
  }
}
