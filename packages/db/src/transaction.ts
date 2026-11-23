import type pg from 'pg'
import { translateDatabaseError } from './errors.js'

/**
 * Runs `work` in one transaction on one pooled client: COMMIT if it resolves,
 * ROLLBACK if it throws. Errors are rethrown as they are; see withTransaction.
 *
 * If the connection is lost, the current or next query of the transaction
 * rejects (at the latest the COMMIT), and the pool drops the client. `work` is
 * never abandoned: the promise settles only after it has ended.
 */
export async function runTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let broken: Error | undefined
  // The pool listens for 'error' only on idle clients. A lost connection emits it
  // (sometimes more than once), and without a listener that would end the process.
  const onError = (err: Error) => {
    broken ??= err
  }
  client.on('error', onError)

  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // The connection is unusable.
      broken ??= rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr))
    }
    throw err
  } finally {
    // A broken client is destroyed instead of returned to the pool. release()
    // adds the pool's own listener, so only then this one can go.
    client.release(broken)
    client.removeListener('error', onError)
  }
}

/** runTransaction whose unavailability errors become DatabaseUnavailableError. */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await runTransaction(pool, work)
  } catch (err) {
    throw translateDatabaseError(err)
  }
}
