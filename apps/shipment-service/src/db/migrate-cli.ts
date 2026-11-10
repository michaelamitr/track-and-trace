import { runMigrations, type MigrationDirection } from './migrations.js'

const databaseUrl = process.env.SHIPMENT_MIGRATIONS_DATABASE_URL
if (!databaseUrl) {
  console.error('SHIPMENT_MIGRATIONS_DATABASE_URL is not set. Add it to .env (see .env.example).')
  process.exit(1)
}

const arg = process.argv[2] ?? 'up'
if (arg !== 'up' && arg !== 'down') {
  console.error(`Unknown direction "${arg}". Use "up" (default) or "down".`)
  process.exit(1)
}
const direction: MigrationDirection = arg

try {
  const ran = await runMigrations({ databaseUrl, direction })
  console.log(
    ran.length === 0
      ? 'No migrations to run.'
      : `${direction === 'up' ? 'Applied' : 'Reverted'}: ${ran.map((m) => m.name).join(', ')}`,
  )
} catch (err) {
  console.error('Shipment migration failed:', err)
  process.exit(1)
}
