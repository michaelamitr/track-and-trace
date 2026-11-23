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
  /**
   * Stops the server but keeps the container, its data and its host port, so
   * clients can reconnect after startServer(). Every open connection is
   * terminated: with "fast" the server tells the clients why (57P01), with
   * "kill" the connections just end. Needs `restartable`.
   */
  stopServer(mode?: 'fast' | 'kill'): Promise<void>
  /** Starts the stopped server again at the same URL; resolves once it accepts connections. */
  startServer(): Promise<void>
  stop(): Promise<void>
}

// Runs the server as a child of the shell, so the container outlives it. After
// a stop it waits until STOPPED is removed and starts the server again.
const STOPPED = '/tmp/stopped'
const RESTART_LOOP = `while :; do docker-entrypoint.sh postgres; while [ -e ${STOPPED} ]; do sleep 0.1; done; done`

const STOP_COMMANDS = {
  fast: 'pg_ctl stop -w -m fast',
  // All server processes at once; a killed server leaves its pid file behind.
  kill: 'pkill -KILL postgres; while pgrep -x postgres; do sleep 0.1; done; rm -f "$PGDATA/postmaster.pid"',
}

/** A fresh Postgres set up by infra/postgres/init, never the compose one. */
export async function startPostgres(options: { restartable?: boolean } = {}): Promise<TestPostgres> {
  const definition = new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment(
      Object.fromEntries(
        Object.entries(TEST_PASSWORDS).map(([role, password]) => [passwordVariable(role), password]),
      ),
    )
    .withCopyDirectoriesToContainer([{ source: INIT_DIR, target: '/docker-entrypoint-initdb.d' }])
    .withExposedPorts(5432)
    // The server starts twice: once for the init scripts, then for real.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
  if (options.restartable) definition.withEntrypoint(['sh', '-c', RESTART_LOOP])
  const container: StartedTestContainer = await definition.start()

  async function exec(script: string): Promise<void> {
    const { exitCode, output } = await container.exec(['sh', '-c', script], { user: 'postgres' })
    if (exitCode !== 0) throw new Error(`Command in the Postgres container failed: ${output}`)
  }

  const hostPort = `${container.getHost()}:${container.getMappedPort(5432)}`
  return {
    url: (role, database) => `postgres://${role}:${TEST_PASSWORDS[role]}@${hostPort}/${database}`,
    async stopServer(mode = 'fast') {
      if (!options.restartable) {
        throw new Error('startPostgres({ restartable: true }) is needed to stop and start the server')
      }
      await exec(`touch ${STOPPED}; ${STOP_COMMANDS[mode]}`)
    },
    async startServer() {
      await exec(`rm -f ${STOPPED}; until pg_isready -q -h 127.0.0.1; do sleep 0.1; done`)
    },
    async stop() {
      await container.stop()
    },
  }
}
