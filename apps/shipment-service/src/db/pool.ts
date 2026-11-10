import pg from 'pg'

export type Logger = {
  error(obj: object, msg?: string): void
}

/**
 * The connection pool of the running service (shipment_service role).
 * connectionTimeoutMillis makes a request fail (503) instead of waiting
 * forever when the database is down.
 */
export function createPool(connectionString: string, log?: Logger): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 })
  // An idle client that loses its connection emits 'error' on the pool; without
  // a listener that would crash the process. The pool replaces the client.
  pool.on('error', (err) => log?.error({ err }, 'idle database client failed'))
  return pool
}
