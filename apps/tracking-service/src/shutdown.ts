export type ShutdownDeps = {
  consumer: { stop(): Promise<void> }
  app: { close(): Promise<unknown> }
  nc: { drain(): Promise<void> }
  pool: { end(): Promise<void> }
}

/**
 * Stops the service in order. Consuming stops first, while the database and
 * NATS are still open, so the message in progress can commit and be acked.
 */
export async function shutdown(deps: ShutdownDeps): Promise<void> {
  await deps.consumer.stop()
  await deps.app.close()
  await deps.nc.drain()
  await deps.pool.end()
}
