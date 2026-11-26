/**
 * The database cannot be reached, refuses connections, or a statement hit its
 * time limit (ADR-0015 rule 6): an error that goes away by waiting. Mapped to
 * 503 in an HTTP request and treated as transient by a consumer.
 */
export class DatabaseUnavailableError extends Error {
  override name = 'DatabaseUnavailableError'
  constructor(options: { cause: unknown }) {
    super('Database unavailable', options)
  }
}

// Node network errors that mean "cannot reach the server".
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
])

// SQLSTATE codes of an unavailable server or a statement over its time limit:
// class 08 (connection exception) is checked by prefix.
const UNAVAILABLE_SQLSTATES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '57014', // query_canceled: statement_timeout of the service pool (createPool)
])

/** The message of pg's own error when query_timeout passes; it has no code. */
const QUERY_READ_TIMEOUT = 'Query read timeout'

// Errors raised by pg itself, without a code.
const PG_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated',
  'Client has encountered a connection error',
  QUERY_READ_TIMEOUT,
]

/**
 * True if pg gave up waiting for the answer to a query (query_timeout). The
 * connection may still be busy with the query; see runTransaction. Also looks
 * at the causes, in case the error was wrapped.
 */
export function isQueryReadTimeout(err: unknown): boolean {
  for (let current = err, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    if (current.message === QUERY_READ_TIMEOUT) return true
  }
  return false
}

/**
 * True if the error means the database is unreachable or a statement hit its
 * time limit, not that the query is wrong.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string') {
    if (NETWORK_CODES.has(code) || UNAVAILABLE_SQLSTATES.has(code) || code.startsWith('08')) {
      return true
    }
  }
  if (PG_MESSAGES.some((message) => err.message.includes(message))) return true
  // Node reports a failed connection to several addresses (IPv4 and IPv6) as an AggregateError.
  if (err instanceof AggregateError) return err.errors.some(isDatabaseUnavailable)
  return false
}

/** Wraps an unavailability error in DatabaseUnavailableError; returns other errors unchanged. */
export function translateDatabaseError(err: unknown): unknown {
  if (err instanceof DatabaseUnavailableError) return err
  return isDatabaseUnavailable(err) ? new DatabaseUnavailableError({ cause: err }) : err
}
