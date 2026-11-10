import type pg from 'pg'
import { translateDatabaseError } from './errors.js'

/**
 * Runs `work` in one transaction on one pooled client: COMMIT if it resolves,
 * ROLLBACK if it throws. Unavailability errors become DatabaseUnavailableError.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient
  try {
    client = await pool.connect()
  } catch (err) {
    throw translateDatabaseError(err)
  }

  let broken: unknown
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // The connection is unusable; release(err) below destroys it instead of returning it.
      broken = rollbackErr
    }
    throw translateDatabaseError(err)
  } finally {
    client.release(broken instanceof Error ? broken : undefined)
  }
}

