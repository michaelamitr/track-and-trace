import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from './migrate-cli.js'
import { migrationNames, runMigrations } from './migrations.js'
import { createPool } from './pool.js'
import { startPostgres, type TestPostgres } from './test-postgres.js'
import { PendingMigrationsError, verifyNoPendingMigrations } from './verify-migrations.js'

// Two throw-away migrations in a temporary directory: the package has none of
// its own. They run as the superuser in the default database, so no service's
// database is used here.
const FIRST = '1700000000001_create-first'
const SECOND = '1700000000002_create-second'

let postgres: TestPostgres
let databaseUrl: string
let pool: pg.Pool
let dir: string
let emptyDir: string

const quiet = () => {}
const run = (direction: 'up' | 'down', migrationsDir = dir) =>
  runMigrations({ databaseUrl, dir: migrationsDir, direction, log: quiet })

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tt-db-migrations-'))
  emptyDir = await mkdtemp(join(tmpdir(), 'tt-db-no-migrations-'))
  // Not empty, but without a .sql file.
  await writeFile(join(emptyDir, 'README.md'), 'no migrations here')
  await writeFile(join(dir, `${FIRST}.sql`), migrationSql('first'))
  await writeFile(join(dir, `${SECOND}.sql`), migrationSql('second'))
  postgres = await startPostgres()
  databaseUrl = postgres.url('postgres', 'postgres')
  pool = createPool(databaseUrl)
})

afterAll(async () => {
  await pool?.end()
  await postgres?.stop()
  await Promise.all([dir, emptyDir].map((path) => rm(path, { recursive: true, force: true })))
})

beforeEach(async () => {
  await pool.query('DROP TABLE IF EXISTS first, second, pgmigrations')
})

function migrationSql(table: string) {
  return `-- Up Migration\nCREATE TABLE ${table} (id integer);\n\n-- Down Migration\nDROP TABLE ${table};\n`
}

async function tables(): Promise<string[]> {
  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  )
  return result.rows.map((row) => row.tablename)
}

describe('runMigrations', () => {
  it('up runs every pending migration in the given directory, in order, once', async () => {
    expect((await run('up')).map((m) => m.name)).toEqual([FIRST, SECOND])
    expect(await tables()).toEqual(['first', 'pgmigrations', 'second'])

    expect(await run('up')).toEqual([])
  })

  it('down reverts only the last migration', async () => {
    await run('up')

    expect((await run('down')).map((m) => m.name)).toEqual([SECOND])
    expect(await tables()).toEqual(['first', 'pgmigrations'])
  })

  it.each(['up', 'down'] as const)('%s rejects a directory without .sql files, naming it', async (direction) => {
    await expect(run(direction, emptyDir)).rejects.toThrow(`No .sql migration files found in ${emptyDir}.`)
    expect(await tables()).toEqual([])
  })
})

describe('verifyNoPendingMigrations', () => {
  it('lists the migration names without the extension, sorted', async () => {
    expect(await migrationNames(dir)).toEqual([FIRST, SECOND])
  })

  it('passes when every migration in the directory has run', async () => {
    await run('up')

    await expect(verifyNoPendingMigrations(pool, dir)).resolves.toBeUndefined()
  })

  it('rejects when no migration has ever run', async () => {
    await expect(verifyNoPendingMigrations(pool, dir)).rejects.toThrow(
      `Pending migrations: ${FIRST}, ${SECOND}. Run pnpm db:migrate first.`,
    )
  })

  it('rejects with the pending migrations only', async () => {
    await run('up')
    await run('down')

    const err = await verifyNoPendingMigrations(pool, dir).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PendingMigrationsError)
    expect((err as Error).message).toBe(`Pending migrations: ${SECOND}. Run pnpm db:migrate first.`)
  })

  it('rejects a directory without .sql files, naming it, even when migrations have run', async () => {
    await run('up')

    await expect(verifyNoPendingMigrations(pool, emptyDir)).rejects.toThrow(
      `No .sql migration files found in ${emptyDir}.`,
    )
  })

  it('rejects a directory that does not exist', async () => {
    await expect(verifyNoPendingMigrations(pool, join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('migrate CLI', () => {
  const VARIABLE = 'SOME_MIGRATIONS_DATABASE_URL'
  const options = () => ({ databaseUrlVariable: VARIABLE, dir, name: 'Some service' })
  const info = vi.spyOn(console, 'info')
  const log = vi.spyOn(console, 'log')
  const error = vi.spyOn(console, 'error')

  beforeEach(() => {
    for (const spy of [info, log, error]) spy.mockReset().mockImplementation(() => {})
  })

  afterEach(() => {
    for (const spy of [info, log, error]) spy.mockReset()
  })

  it('runs up by default, then reports that there is nothing to run', async () => {
    expect(await migrate(options(), [], { [VARIABLE]: databaseUrl })).toBe(0)
    expect(log).toHaveBeenLastCalledWith(`Applied: ${FIRST}, ${SECOND}`)

    expect(await migrate(options(), ['up'], { [VARIABLE]: databaseUrl })).toBe(0)
    expect(log).toHaveBeenLastCalledWith('No migrations to run.')
  })

  it('reverts the last migration with "down"', async () => {
    await run('up')

    expect(await migrate(options(), ['down'], { [VARIABLE]: databaseUrl })).toBe(0)
    expect(log).toHaveBeenLastCalledWith(`Reverted: ${SECOND}`)
  })

  it('fails without its variable, naming it', async () => {
    expect(await migrate(options(), ['up'], { OTHER: databaseUrl })).toBe(1)
    expect(error).toHaveBeenCalledWith(`${VARIABLE} is not set. Add it to .env (see .env.example).`)
    expect(await tables()).toEqual([])
  })

  it('fails for an unknown direction', async () => {
    expect(await migrate(options(), ['sideways'], { [VARIABLE]: databaseUrl })).toBe(1)
    expect(error).toHaveBeenCalledWith('Unknown direction "sideways". Use "up" (default) or "down".')
    expect(await tables()).toEqual([])
  })

  it('fails with the service name when the migration fails', async () => {
    const missing = { ...options(), dir: join(dir, 'missing') }

    expect(await migrate(missing, ['up'], { [VARIABLE]: databaseUrl })).toBe(1)
    expect(error).toHaveBeenCalledWith('Some service migration failed:', expect.any(Error))
  })
})
