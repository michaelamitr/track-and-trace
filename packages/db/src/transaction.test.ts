import { EventEmitter } from 'node:events'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseUnavailableError } from './errors.js'
import { runTransaction, withTransaction } from './transaction.js'

/** A pool with one client that records its queries; `fail` makes a statement throw. */
function fakePool(fail: Record<string, Error> = {}) {
  const queries: string[] = []
  const release = vi.fn()
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      queries.push(sql)
      if (fail[sql]) throw fail[sql]
    },
    release,
  })
  const pool = { connect: async () => client } as unknown as pg.Pool
  return { pool, client, queries, release }
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

describe('a connection lost while the client is checked out', () => {
  const lost = new Error('Connection terminated unexpectedly')

  it('releases the client with the first error as broken, also if the rollback works', async () => {
    const { pool, client, release } = fakePool()
    const err = new Error('boom')

    await expect(
      withTransaction(pool, async () => {
        client.emit('error', lost)
        client.emit('error', new Error('another one'))
        throw err
      }),
    ).rejects.toBe(err)

    expect(release).toHaveBeenCalledExactlyOnceWith(lost)
  })

  it('becomes DatabaseUnavailableError through the next query', async () => {
    const { pool, client, release } = fakePool({ COMMIT: lost, ROLLBACK: lost })

    await expect(withTransaction(pool, async () => void client.emit('error', lost))).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    )

    expect(release).toHaveBeenCalledExactlyOnceWith(lost)
  })

  it.each([
    ['success', async () => {}],
    ['failure', async () => Promise.reject(new Error('boom'))],
  ])('is handled until the client is released, and no listener is left after %s', async (_label, work) => {
    const { pool, client, release } = fakePool()
    let listenersAtRelease = 0
    release.mockImplementation(() => {
      listenersAtRelease = client.listenerCount('error')
    })

    await withTransaction(pool, work).catch(() => {})

    expect(listenersAtRelease).toBe(1)
    expect(client.listenerCount('error')).toBe(0)
  })
})

describe('runTransaction', () => {
  it('rejects with the errors as they are', async () => {
    const cause = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    const unreachable = { connect: () => Promise.reject(cause) } as unknown as pg.Pool

    await expect(runTransaction(unreachable, async () => {})).rejects.toBe(cause)
    await expect(runTransaction(fakePool().pool, () => Promise.reject(cause))).rejects.toBe(cause)
  })
})
