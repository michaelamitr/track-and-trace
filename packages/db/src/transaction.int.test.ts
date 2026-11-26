import { setTimeout as sleep } from 'node:timers/promises'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseUnavailableError } from './errors.js'
import { createPool } from './pool.js'
import { startPostgres, type TestPostgres } from './test-postgres.js'
import { uncaughtErrorsDuring } from './test-uncaught.js'
import { withTransaction } from './transaction.js'

// Superuser and default database, so no service's database is used here.
let postgres: TestPostgres
let pool: pg.Pool

beforeAll(async () => {
  postgres = await startPostgres({ restartable: true })
})

afterAll(async () => {
  await postgres?.stop()
})

beforeEach(async () => {
  await postgres.startServer()
  // Every client of the pool is the one of the transaction.
  pool = createPool(postgres.url('postgres', 'postgres'))
  await pool.query('DROP TABLE IF EXISTS items')
  await pool.query('CREATE TABLE items (id integer)')
})

afterEach(async () => {
  await pool.end()
})

async function backendPid(db: Pick<pg.Pool | pg.PoolClient, 'query'>): Promise<number> {
  return (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
}

/** Resolves once the server runs the query, not only once it was sent. */
async function waitUntilSleeping(): Promise<void> {
  const observer = createPool(postgres.url('postgres', 'postgres'))
  try {
    for (;;) {
      const { rows } = await observer.query("SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep'")
      if (rows.length > 0) return
      await sleep(20)
    }
  } finally {
    await observer.end()
  }
}

/** The transaction failed, the process survived, and the pool works again after the restart. */
async function expectRecovery(uncaught: unknown[], failure: unknown, lostPid: number): Promise<void> {
  expect(uncaught).toEqual([])
  expect(failure).toBeInstanceOf(DatabaseUnavailableError)
  // The broken client is gone, not back in the pool.
  expect([pool.totalCount, pool.idleCount]).toEqual([0, 0])

  await postgres.startServer()

  const newPid = await withTransaction(pool, async (client) => {
    await client.query('INSERT INTO items VALUES (2)')
    return backendPid(client)
  })
  expect(newPid).not.toBe(lostPid)
  // Nothing of the failed transaction was saved.
  expect((await pool.query('SELECT id FROM items')).rows).toEqual([{ id: 2 }])
}

describe('time limits of the service pool (ADR-0015 rule 6)', () => {
  it('a statement over statement_timeout fails with DatabaseUnavailableError and the client is reused', async () => {
    const started = Date.now()
    const failure = await withTransaction(pool, async (client) => {
      await client.query('SELECT pg_sleep(10)')
    }).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(DatabaseUnavailableError)
    expect((failure as Error).cause).toMatchObject({ code: '57014' })
    expect(Date.now() - started).toBeLessThan(6_000)
    // The connection was fine: ROLLBACK worked and the client went back to the pool.
    expect([pool.totalCount, pool.idleCount]).toEqual([1, 1])
  })

  it('a query read timeout destroys the client without waiting for a ROLLBACK', async () => {
    let lostPid = 0
    const started = Date.now()
    const failure = await withTransaction(pool, async (client) => {
      lostPid = await backendPid(client)
      await client.query('INSERT INTO items VALUES (1)')
      // Only the client-side limit (query_timeout, 6 s) is left.
      await client.query('SET LOCAL statement_timeout = 0')
      await client.query('SELECT pg_sleep(10)')
    }).catch((err: unknown) => err)
    const elapsed = Date.now() - started

    expect(failure).toBeInstanceOf(DatabaseUnavailableError)
    expect((failure as Error).cause).toMatchObject({ message: 'Query read timeout' })
    // A ROLLBACK would have waited for pg_sleep (10 s) or its own timeout (another 6 s).
    expect(elapsed).toBeGreaterThanOrEqual(5_900)
    expect(elapsed).toBeLessThan(8_000)
    expect([pool.totalCount, pool.idleCount]).toEqual([0, 0])

    const newPid = await withTransaction(pool, (client) => backendPid(client))
    expect(newPid).not.toBe(lostPid)
    // Nothing of the failed transaction was saved; the server ended it with the connection.
    await vi.waitFor(async () => {
      const { rows } = await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [lostPid])
      expect(rows).toEqual([])
    }, { timeout: 10_000, interval: 100 })
    expect((await pool.query('SELECT id FROM items')).rows).toEqual([])
  })
})

describe.each(['fast', 'kill'] as const)('withTransaction when Postgres stops (%s) during the transaction', (mode) => {
  it('rejects and recovers when a query is running', async () => {
    let lostPid = 0
    let failure: unknown
    const uncaught = await uncaughtErrorsDuring(async () => {
      const running = withTransaction(pool, async (client) => {
        lostPid = await backendPid(client)
        await client.query('INSERT INTO items VALUES (1)')
        await client.query('SELECT pg_sleep(60)')
      }).catch((err: unknown) => err)
      await waitUntilSleeping()
      await postgres.stopServer(mode)
      failure = await running
      // A late error of the released client counts too.
      await sleep(200)
    })

    await expectRecovery(uncaught, failure, lostPid)
  })

  it('rejects and recovers when no query is running', async () => {
    let lostPid = 0
    let failure: unknown
    const uncaught = await uncaughtErrorsDuring(async () => {
      failure = await withTransaction(pool, async (client) => {
        lostPid = await backendPid(client)
        await client.query('INSERT INTO items VALUES (1)')
        await postgres.stopServer(mode)
        await sleep(200)
        await client.query('INSERT INTO items VALUES (1)')
      }).catch((err: unknown) => err)
    })

    await expectRecovery(uncaught, failure, lostPid)
  })

  it('rejects when the work sends no more queries, because the commit fails', async () => {
    let lostPid = 0
    let failure: unknown
    const uncaught = await uncaughtErrorsDuring(async () => {
      failure = await withTransaction(pool, async (client) => {
        lostPid = await backendPid(client)
        await client.query('INSERT INTO items VALUES (1)')
        await postgres.stopServer(mode)
        await sleep(200)
      }).catch((err: unknown) => err)
    })

    await expectRecovery(uncaught, failure, lostPid)
  })
})
