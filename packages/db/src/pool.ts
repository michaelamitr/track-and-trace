import pg from 'pg'

export type Logger = {
  error(obj: object, msg?: string): void
}

/** Server-side limit of every statement of a service pool (ADR-0015 rule 6). */
export const STATEMENT_TIMEOUT_MS = 5_000
/**
 * Client-side limit of the same statements: slightly above STATEMENT_TIMEOUT_MS,
 * so the server limit normally fires first. Covers a connection that silently
 * stops answering.
 */
export const QUERY_TIMEOUT_MS = 6_000
/** Waiting for a connection from the pool. */
export const CONNECTION_TIMEOUT_MS = 5_000

/**
 * The connection pool of the running service (its data-only runtime role, ADR-0008).
 * Not for migrations, which have no statement limit and use their own connection.
 * The time limits (ADR-0015 rule 6) make a request fail (503) or a consumer
 * retry instead of waiting forever when the database is down or a statement is stuck.
 * Check out clients only with runTransaction or withTransaction: a client taken with
 * pool.connect() has no 'error' listener, so a lost connection would end the process.
 */
export function createPool(connectionString: string, log?: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  })
  // An idle client that loses its connection emits 'error' on the pool; without
  // a listener that would crash the process. The pool replaces the client.
  pool.on('error', (err) => log?.error({ err }, 'idle database client failed'))
  return pool
}
