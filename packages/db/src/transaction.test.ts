import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseUnavailableError } from './errors.js'
import { withTransaction } from './transaction.js'

/** A pool with one client that records its queries; `fail` makes a statement throw. */
function fakePool(fail: Record<string, Error> = {}) {
  const queries: string[] = []
  const release = vi.fn()
  const client = {
    async query(sql: string) {
      queries.push(sql)
      if (fail[sql]) throw fail[sql]
    },
    release,
  }
  const pool = { connect: async () => client } as unknown as pg.Pool
  return { pool, queries, release }
}

describe('withTransaction', () => {
  it('commits, returns the result and releases the client', async () => {
    const { pool, queries, release } = fakePool()

    const result = await withTransaction(pool, async (client) => {
      await client.query('WORK')
      return 42
    })

    expect(result).toBe(42)
    expect(queries).toEqual(['BEGIN', 'WORK', 'COMMIT'])
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('rolls back, rethrows the error unchanged and releases the client', async () => {
    const { pool, queries, release } = fakePool()
    const err = new Error('boom')

    await expect(
      withTransaction(pool, async () => {
        throw err
      }),
    ).rejects.toBe(err)

    expect(queries).toEqual(['BEGIN', 'ROLLBACK'])
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('destroys the client when the rollback fails and reports the original error', async () => {
    const rollbackErr = new Error('rollback failed')
    const { pool, release } = fakePool({ ROLLBACK: rollbackErr })
    const err = new Error('boom')

    await expect(
      withTransaction(pool, async () => {
        throw err
      }),
    ).rejects.toBe(err)

    expect(release).toHaveBeenCalledExactlyOnceWith(rollbackErr)
  })

  it('throws DatabaseUnavailableError when no connection can be opened', async () => {
    const cause = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    const pool = { connect: () => Promise.reject(cause) } as unknown as pg.Pool
    const work = vi.fn()

    await expect(withTransaction(pool, work)).rejects.toMatchObject({ name: 'DatabaseUnavailableError', cause })
    expect(work).not.toHaveBeenCalled()
  })

  it('throws DatabaseUnavailableError when the connection is lost during the work', async () => {
    const { pool } = fakePool()

    await expect(
      withTransaction(pool, async () => {
        throw new Error('Connection terminated unexpectedly')
      }),
    ).rejects.toBeInstanceOf(DatabaseUnavailableError)
  })
})
