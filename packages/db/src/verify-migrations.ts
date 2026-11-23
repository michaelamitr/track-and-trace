import type pg from 'pg'
import { migrationNames, MIGRATIONS_TABLE } from './migrations.js'

const UNDEFINED_TABLE = '42P01'

export class PendingMigrationsError extends Error {
  override name = 'PendingMigrationsError'
}

/**
 * Startup check (ADR-0008): every migration file in the service's `dir` must be
 * recorded in the pgmigrations table of its database. The service does not run migrations
 * itself. Rejects a `dir` without migrations (a wrong path), see migrationNames.
 */
export async function verifyNoPendingMigrations(pool: pg.Pool, dir: string): Promise<void> {
  const expected = await migrationNames(dir)
  let applied: Set<string>
  try {
    const result = await pool.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`)
    applied = new Set(result.rows.map((row) => row.name))
  } catch (err) {
    // No migration has ever run.
    if ((err as { code?: unknown }).code !== UNDEFINED_TABLE) throw err
    applied = new Set()
  }
  const pending = expected.filter((name) => !applied.has(name))
  if (pending.length > 0) {
    throw new PendingMigrationsError(
      `Pending migrations: ${pending.join(', ')}. Run pnpm db:migrate first.`,
    )
  }
}
