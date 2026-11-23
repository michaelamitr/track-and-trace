// Integration-test helper only; not exported from index.ts. Other workspace
// packages import it through the "@tt/db/testing" subpath.
import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

/** Must match the postgres service image in compose.yaml (checked by test-postgres.test.ts). */
export const POSTGRES_IMAGE = 'postgres:18-alpine'

const INIT_DIR = fileURLToPath(new URL('../../../infra/postgres/init', import.meta.url))

/**
 * Test-only passwords of the superuser and of every role the init scripts
 * create: a new service only adds its entries here. The init scripts get each
 * one in passwordVariable(role) (checked by test-postgres.test.ts).
 * Letters and digits only, because they are part of a URL.
 */
export const TEST_PASSWORDS = {
  postgres: 'testpostgres',
  shipment_owner: 'testshipmentowner',
  shipment_service: 'testshipmentservice',
  tracking_owner: 'testtrackingowner',
  tracking_service: 'testtrackingservice',
} as const

export type TestRole = keyof typeof TEST_PASSWORDS

/** "shipment_owner" -> "SHIPMENT_OWNER_PASSWORD" */
export function passwordVariable(role: string): string {
  return `${role.toUpperCase()}_PASSWORD`
}

export type TestPostgres = {
  /** Connection URL of `database` for `role`, e.g. url('shipment_owner', 'shipment_db'). */
  url(role: TestRole, database: string): string
  stop(): Promise<void>
}

/** A fresh Postgres set up by infra/postgres/init, never the compose one. */
export async function startPostgres(): Promise<TestPostgres> {
  const container: StartedTestContainer = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment(
      Object.fromEntries(
        Object.entries(TEST_PASSWORDS).map(([role, password]) => [passwordVariable(role), password]),
      ),
    )
    .withCopyDirectoriesToContainer([{ source: INIT_DIR, target: '/docker-entrypoint-initdb.d' }])
    .withExposedPorts(5432)
    // The server starts twice: once for the init scripts, then for real.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start()
  const hostPort = `${container.getHost()}:${container.getMappedPort(5432)}`
  return {
    url: (role, database) => `postgres://${role}:${TEST_PASSWORDS[role]}@${hostPort}/${database}`,
    async stop() {
      await container.stop()
    },
  }
}
