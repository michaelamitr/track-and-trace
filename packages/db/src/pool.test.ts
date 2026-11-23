import { afterEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { createPool } from './pool.js'

let pool: pg.Pool | undefined

afterEach(async () => {
  await pool?.end()
  pool = undefined
})

describe('createPool', () => {
  it('limits the connections and the time to wait for one', () => {
    pool = createPool('postgres://user:secret@127.0.0.1:1/some_db')

    expect(pool.options).toMatchObject({ max: 10, connectionTimeoutMillis: 5_000 })
  })

  it('logs an error of an idle client instead of crashing', () => {
    const log = { error: vi.fn() }
    pool = createPool('postgres://user:secret@127.0.0.1:1/some_db', log)
    const err = new Error('Connection terminated unexpectedly')

    // An 'error' event without a listener would be thrown here.
    pool.emit('error', err, {} as pg.PoolClient)

    expect(log.error).toHaveBeenCalledWith({ err }, 'idle database client failed')
  })
})
