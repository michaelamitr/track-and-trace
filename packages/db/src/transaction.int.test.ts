import { setTimeout as sleep } from 'node:timers/promises'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
