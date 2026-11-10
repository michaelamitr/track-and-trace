// Integration-test helper only.
import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'

/** Must match the postgres service image in compose.yaml (checked by test-postgres.test.ts). */
export const POSTGRES_IMAGE = 'postgres:18-alpine'

const INIT_DIR = fileURLToPath(new URL('../../../../infra/postgres/init', import.meta.url))

// Test-only passwords: letters and digits, because they are part of a URL.
const PASSWORDS = {
  postgres: 'testpostgres',
  shipment_owner: 'testshipmentowner',
  shipment_service: 'testshipmentservice',
} as const

export type TestPostgres = {
  /** URL of shipment_db for shipment_owner (migrations). */
  ownerUrl: string
  /** URL of shipment_db for shipment_service (data only). */
  serviceUrl: string
  stop(): Promise<void>
}

/** A fresh Postgres set up by infra/postgres/init, never the compose one. */
export async function startPostgres(): Promise<TestPostgres> {
  const container: StartedTestContainer = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_PASSWORD: PASSWORDS.postgres,
      SHIPMENT_OWNER_PASSWORD: PASSWORDS.shipment_owner,
      SHIPMENT_SERVICE_PASSWORD: PASSWORDS.shipment_service,
    })
    .withCopyDirectoriesToContainer([{ source: INIT_DIR, target: '/docker-entrypoint-initdb.d' }])
    .withExposedPorts(5432)
    // The server starts twice: once for the init scripts, then for real.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start()
  const hostPort = `${container.getHost()}:${container.getMappedPort(5432)}`
  const url = (role: 'shipment_owner' | 'shipment_service') =>
    `postgres://${role}:${PASSWORDS[role]}@${hostPort}/shipment_db`
  return {
    ownerUrl: url('shipment_owner'),
    serviceUrl: url('shipment_service'),
    async stop() {
      await container.stop()
    },
  }
}
