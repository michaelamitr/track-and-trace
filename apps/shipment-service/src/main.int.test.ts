import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from './db/migrations.js'
import { verifyNoPendingMigrations } from './db/verify-migrations.js'
import { startTestDatabase, type TestDatabase } from './test-support.js'

const run = promisify(execFile)
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))
const SERVICE_PASSWORD = 'testshipmentservice'

let db: TestDatabase

beforeAll(async () => {
  db = await startTestDatabase()
})

afterAll(async () => {
  await db?.stop()
})

/** Starts main.ts like `pnpm start` and expects it to exit with an error. */
async function startServiceExpectingFailure(env: Record<string, string>) {
  try {
    await run(TSX, ['src/main.ts'], {
      cwd: PACKAGE_DIR,
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 20_000,
    })
  } catch (err) {
    const { code, stdout, stderr } = err as { code: number; stdout: string; stderr: string }
    return { code, output: stdout + stderr }
  }
  throw new Error('main.ts exited successfully')
}

describe('startup', () => {
  it('passes the migration check when every migration has run', async () => {
    await expect(verifyNoPendingMigrations(db.pool)).resolves.toBeUndefined()
  })

  it('fails fast when a migration is pending, without logging the connection string', async () => {
    await runMigrations({ databaseUrl: db.postgres.ownerUrl, direction: 'down', log: () => {} })
    try {
      await expect(verifyNoPendingMigrations(db.pool)).rejects.toThrow(
        'Pending migrations: 1794343443863_create-outbox. Run pnpm db:migrate first.',
      )

      const { code, output } = await startServiceExpectingFailure({
        SHIPMENT_DATABASE_URL: db.postgres.serviceUrl,
        // Never reached: the migration check comes first.
        NATS_URL: 'nats://127.0.0.1:1',
      })

      expect(code).toBe(1)
      expect(output).toContain('Run pnpm db:migrate first.')
      expect(output).not.toContain(SERVICE_PASSWORD)
    } finally {
      await runMigrations({ databaseUrl: db.postgres.ownerUrl, direction: 'up', log: () => {} })
    }
  })

  it('fails fast when NATS is unreachable', async () => {
    const { code, output } = await startServiceExpectingFailure({
      SHIPMENT_DATABASE_URL: db.postgres.serviceUrl,
      NATS_URL: 'nats://127.0.0.1:1',
    })

    expect(code).toBe(1)
    expect(output).toContain('startup failed')
    expect(output).not.toContain(SERVICE_PASSWORD)
  })

  it('fails fast with a clear message when SHIPMENT_DATABASE_URL is missing', async () => {
    const { code, output } = await startServiceExpectingFailure({})

    expect(code).toBe(1)
    expect(output).toContain('SHIPMENT_DATABASE_URL is not set')
  })
})
