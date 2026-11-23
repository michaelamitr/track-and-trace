import { runMigrations, type MigrationDirection } from './migrations.js'

export type MigrateCliOptions = {
  /** Variable with the owner role's URL, e.g. SHIPMENT_MIGRATIONS_DATABASE_URL. */
  databaseUrlVariable: string
  /** The service's migrations directory (an absolute path). */
  dir: string
  /** The service's name in messages, e.g. "Shipment". */
  name: string
}

/** The body of a service's migrate-cli.ts: "up" (default) or "down" as the first argument. */
export async function runMigrateCli(options: MigrateCliOptions): Promise<void> {
  const exitCode = await migrate(options, process.argv.slice(2), process.env)
  if (exitCode !== 0) process.exit(exitCode)
}

/** Runs the command and returns its exit code. Exported for tests; services call runMigrateCli. */
export async function migrate(
  options: MigrateCliOptions,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const databaseUrl = env[options.databaseUrlVariable]
  if (!databaseUrl) {
    console.error(`${options.databaseUrlVariable} is not set. Add it to .env (see .env.example).`)
    return 1
  }

  const arg = args[0] ?? 'up'
  if (arg !== 'up' && arg !== 'down') {
    console.error(`Unknown direction "${arg}". Use "up" (default) or "down".`)
    return 1
  }
  const direction: MigrationDirection = arg

  try {
    const ran = await runMigrations({ databaseUrl, dir: options.dir, direction })
    console.log(
      ran.length === 0
        ? 'No migrations to run.'
        : `${direction === 'up' ? 'Applied' : 'Reverted'}: ${ran.map((m) => m.name).join(', ')}`,
    )
    return 0
  } catch (err) {
    console.error(`${options.name} migration failed:`, err)
    return 1
  }
}
