import { fileURLToPath } from 'node:url'
import { runMigrations, verifyNoPendingMigrations } from '@tt/db'
import { TEST_PASSWORDS } from '@tt/db/testing'
import { startService, stopAllProcesses } from '@tt/lifecycle/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR } from './db/migrations.js'
import { startTestDatabase, type TestDatabase } from './test-support.js'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const SERVICE_PASSWORD = TEST_PASSWORDS.shipment_service

let db: TestDatabase

beforeAll(async () => {
  db = await startTestDatabase()
})

afterAll(async () => {
  await db?.stop()
})

// Every started service ends here, also when its test failed or timed out:
// SIGTERM, then SIGKILL; before the containers are stopped in afterAll.
afterEach(async () => {
  await stopAllProcesses()
})

/** Starts main.ts like `pnpm start` (without .env) and expects it to exit with an error. */
async function startServiceExpectingFailure(env: Record<string, string>) {
  const service = startService({ cwd: PACKAGE_DIR, env })
  const { code } = await service.exited
  if (code === 0) throw new Error('main.ts exited successfully')
  return { code, output: service.output() }
}

describe('startup', () => {
  it('passes the migration check when every migration has run', async () => {
    await expect(verifyNoPendingMigrations(db.pool, MIGRATIONS_DIR)).resolves.toBeUndefined()
  })

  it('fails fast when a migration is pending, without logging the connection string', async () => {
    await runMigrations({ databaseUrl: db.ownerUrl, dir: MIGRATIONS_DIR, direction: 'down', log: () => {} })
    try {
      await expect(verifyNoPendingMigrations(db.pool, MIGRATIONS_DIR)).rejects.toThrow(
        'Pending migrations: 1794343443863_create-outbox. Run pnpm db:migrate first.',
      )

      const { code, output } = await startServiceExpectingFailure({
        SHIPMENT_DATABASE_URL: db.serviceUrl,
        // Never reached: the migration check comes first.
        NATS_URL: 'nats://127.0.0.1:1',
      })

      expect(code).toBe(1)
      expect(output).toContain('Run pnpm db:migrate first.')
      expect(output).not.toContain(SERVICE_PASSWORD)
    } finally {
      await runMigrations({ databaseUrl: db.ownerUrl, dir: MIGRATIONS_DIR, direction: 'up', log: () => {} })
    }
  })

  it('fails fast when NATS is unreachable', async () => {
    const { code, output } = await startServiceExpectingFailure({
      SHIPMENT_DATABASE_URL: db.serviceUrl,
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
