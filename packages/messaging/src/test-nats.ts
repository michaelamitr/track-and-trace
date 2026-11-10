// Integration-test helper only; not exported from index.ts. Other workspace
// packages import it through the "@tt/messaging/testing" subpath.
import { createServer } from 'node:net'
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import {
  GenericContainer,
  getContainerRuntimeClient,
  Wait,
  type StartedTestContainer,
} from 'testcontainers'
import { connectNats } from './connection.js'

/** Must match the nats service image in compose.yaml (checked by test-nats.test.ts). */
export const NATS_IMAGE = 'nats:2.14-alpine'

export type TestNats = {
  /** Client URL of the test server. */
  url: string
  nc: NatsConnection
  js: JetStreamClient
  jsm: JetStreamManager
  /**
   * Stops the server but keeps the container, its JetStream data and its host
   * port, so clients can reconnect after startServer(). Needs `restartable`.
   */
  stopServer(): Promise<void>
  /** Starts the server stopped by stopServer() again. */
  startServer(): Promise<void>
  stop(): Promise<void>
}

/** A free TCP port on this machine. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('Could not determine a free port'))
      })
    })
  })
}

/**
 * A fresh JetStream-enabled NATS for one test file, never the compose one.
 * With `restartable: true` the server gets a fixed host port, so it can be
 * stopped and started again at the same URL (a mapped random port would change).
 */
export async function startNats(options: { restartable?: boolean } = {}): Promise<TestNats> {
  const port = options.restartable ? { container: 4222, host: await freePort() } : 4222
  const container: StartedTestContainer = await new GenericContainer(NATS_IMAGE)
    .withCommand(['-js'])
    .withExposedPorts(port)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start()
  const url = `nats://${container.getHost()}:${container.getMappedPort(4222)}`
  const nc = await connectNats(url, { maxReconnectAttempts: -1, reconnectTimeWait: 250 })

  async function runtimeContainer() {
    if (!options.restartable) {
      throw new Error('startNats({ restartable: true }) is needed to stop and start the server')
    }
    const client = await getContainerRuntimeClient()
    return { client, handle: client.container.getById(container.getId()) }
  }

  return {
    url,
    nc,
    js: jetstream(nc),
    jsm: await jetstreamManager(nc),
    async stopServer() {
      const { client, handle } = await runtimeContainer()
      await client.container.stop(handle)
    },
    async startServer() {
      const { client, handle } = await runtimeContainer()
      await client.container.start(handle)
    },
    async stop() {
      await nc.close()
      await container.stop()
    },
  }
}
