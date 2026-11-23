import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startPostgres, type TestPostgres } from '@tt/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url))
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url))

let postgres: TestPostgres

beforeAll(async () => {
  postgres = await startPostgres()
})

afterAll(async () => {
  await postgres?.stop()
})

/** Runs migrate-cli.ts like `pnpm db:migrate`, but with only the given variables (no .env). */
function migrateCli(direction: string, env: Record<string, string>) {
  return run(TSX, ['src/db/migrate-cli.ts', direction], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env.PATH ?? '', ...env },
    timeout: 20_000,
  })
}

describe('migrate-cli', () => {
  it("runs Shipment's own migrations with SHIPMENT_MIGRATIONS_DATABASE_URL", async () => {
    const env = { SHIPMENT_MIGRATIONS_DATABASE_URL: postgres.url('shipment_owner', 'shipment_db') }

    const up = await migrateCli('up', env)
    expect(up.stdout).toContain('Applied: 1794309982916_create-shipments, 1794343443863_create-outbox')

    const down = await migrateCli('down', env)
    expect(down.stdout).toContain('Reverted: 1794343443863_create-outbox')
  })

  it('exits with 1 and names the variable when it is missing', async () => {
    await expect(migrateCli('up', {})).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('SHIPMENT_MIGRATIONS_DATABASE_URL is not set'),
    })
  })
})
