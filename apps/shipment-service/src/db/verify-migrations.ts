import { readdir } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import type pg from 'pg'
import { MIGRATIONS_DIR, MIGRATIONS_TABLE } from './migrations.js'

const UNDEFINED_TABLE = '42P01'

export class PendingMigrationsError extends Error {
  override name = 'PendingMigrationsError'
}

/** Migration names as node-pg-migrate records them: the file name without its extension. */
export async function migrationNames(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = await readdir(dir)
  return files
    .filter((file) => extname(file) === '.sql')
    .map((file) => basename(file, '.sql'))
    .sort()
}

/**
 * Startup check (ADR-0008): every migration file must be recorded in the
 * pgmigrations table. The service does not run migrations itself.
 */
export async function verifyNoPendingMigrations(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<void> {
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
