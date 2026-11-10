import { fileURLToPath } from 'node:url'
import { runner } from 'node-pg-migrate'

export type RunMigration = Awaited<ReturnType<typeof runner>>[number]

/** Absolute path, so the result does not depend on the current directory. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))

/** Table in which node-pg-migrate records the migrations that have run. */
export const MIGRATIONS_TABLE = 'pgmigrations'

export type MigrationDirection = 'up' | 'down'

/**
 * Runs the migrations as shipment_owner: "up" runs all pending ones, "down" reverts the last one.
 * Returns the migrations that were run.
 */
export async function runMigrations(options: {
  databaseUrl: string
  direction: MigrationDirection
  log?: (message: string) => void
}): Promise<RunMigration[]> {
  return runner({
    databaseUrl: options.databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    direction: options.direction,
    count: options.direction === 'down' ? 1 : Number.POSITIVE_INFINITY,
    checkOrder: true,
    ...(options.log ? { log: options.log } : {}),
  })
}
