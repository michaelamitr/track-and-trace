import { readdir } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { runner } from 'node-pg-migrate'

export type RunMigration = Awaited<ReturnType<typeof runner>>[number]

/** Table in which node-pg-migrate records the migrations that have run. */
export const MIGRATIONS_TABLE = 'pgmigrations'

export type MigrationDirection = 'up' | 'down'

/**
 * Migration names as node-pg-migrate records them: the file name without its
 * extension. A directory without .sql files is rejected: it means a wrong path,
 * which would otherwise look like "nothing to run" and "nothing pending".
 */
export async function migrationNames(dir: string): Promise<string[]> {
  const names = (await readdir(dir))
    .filter((file) => extname(file) === '.sql')
    .map((file) => basename(file, '.sql'))
    .sort()
  if (names.length === 0) throw new Error(`No .sql migration files found in ${dir}.`)
  return names
}

/**
 * Runs the service's migrations in `dir` (an absolute path) as its owner role:
 * "up" runs all pending ones, "down" reverts the last one.
 * Returns the migrations that were run. Rejects a `dir` without migrations.
 */
export async function runMigrations(options: {
  databaseUrl: string
  dir: string
  direction: MigrationDirection
  log?: (message: string) => void
}): Promise<RunMigration[]> {
  await migrationNames(options.dir)
  return runner({
    databaseUrl: options.databaseUrl,
    dir: options.dir,
    migrationsTable: MIGRATIONS_TABLE,
    direction: options.direction,
    count: options.direction === 'down' ? 1 : Number.POSITIVE_INFINITY,
    checkOrder: true,
    ...(options.log ? { log: options.log } : {}),
  })
}
