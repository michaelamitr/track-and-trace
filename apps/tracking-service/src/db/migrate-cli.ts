import { runMigrateCli } from '@tt/db'
import { MIGRATIONS_DIR } from './migrations.js'

await runMigrateCli({
  databaseUrlVariable: 'TRACKING_MIGRATIONS_DATABASE_URL',
  dir: MIGRATIONS_DIR,
  name: 'Tracking',
})
