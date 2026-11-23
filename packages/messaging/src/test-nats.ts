// Integration-test helper only; not exported from index.ts. Other workspace
// packages import it through the "@tt/messaging/testing" subpath.
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import {
  GenericContainer,
  getContainerRuntimeClient,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers'
import { connectNats } from './connection.js'
import { reservePort, type ReservedPort } from './test-port.js'

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
  /**
   * Starts the server stopped by stopServer() again, on the same host port.
   * Resolves once nc, js and jsm work again.
   */
  startServer(): Promise<void>
  /** Where Docker runs the container now. */
  placement(): Promise<{ hostPorts: string[]; networks: string[] }>
  stop(): Promise<void>
}

/** Waits until the connection is back and JetStream has recovered. */
async function waitUntilUsable(nc: NatsConnection, jsm: JetStreamManager): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      // rtt() fails while disconnected; a request sent then could be lost.
      await nc.rtt()
      await jsm.getAccountInfo()
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

/**
 * A fresh JetStream-enabled NATS for one test file, never the compose one.
 * With `restartable: true` the server can be stopped and started again at the
 * same URL, and clients can only reconnect to this server:
 * - its host port is reserved (reservePort), also while it is stopped;
 * - it has its own Docker network. In the shared one Docker gives the IP of a
 *   stopped container to the next one that starts, and connections pending on
 *   the old host port would then reach that other container.
 */
export async function startNats(options: { restartable?: boolean } = {}): Promise<TestNats> {
  let reserved: ReservedPort | undefined
  let network: StartedNetwork | undefined
  let container: StartedTestContainer | undefined
  let nc: NatsConnection | undefined

  async function cleanUp() {
    await nc?.close()
    await container?.stop()
    await network?.stop()
    await reserved?.release()
  }

  try {
    const definition = new GenericContainer(NATS_IMAGE)
      .withCommand(['-js'])
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    if (options.restartable) {
      reserved = await reservePort()
      network = await new Network().start()
      definition.withExposedPorts({ container: 4222, host: reserved.port }).withNetwork(network)
    } else {
      definition.withExposedPorts(4222)
    }
    container = await definition.start()
    const url = `nats://${container.getHost()}:${container.getMappedPort(4222)}`
    nc = await connectNats(url, { maxReconnectAttempts: -1, reconnectTimeWait: 250 })
    const jsm = await jetstreamManager(nc)
    const containerId = container.getId()
    const openNc = nc

    async function runtimeContainer() {
      const client = await getContainerRuntimeClient()
      return { client, handle: client.container.getById(containerId) }
    }

    function requireRestartable() {
      if (!options.restartable) {
        throw new Error('startNats({ restartable: true }) is needed to stop and start the server')
      }
    }

    return {
      url,
      nc,
      js: jetstream(nc),
      jsm,
      async stopServer() {
        requireRestartable()
        const { client, handle } = await runtimeContainer()
        await client.container.stop(handle)
      },
      async startServer() {
        requireRestartable()
        const { client, handle } = await runtimeContainer()
        await client.container.start(handle)
        await waitUntilUsable(openNc, jsm)
      },
      async placement() {
        const { handle } = await runtimeContainer()
        const { Ports, Networks } = (await handle.inspect()).NetworkSettings
        return {
          hostPorts: [...new Set((Ports['4222/tcp'] ?? []).map((binding) => binding.HostPort))],
          networks: Object.keys(Networks),
        }
      },
      stop: cleanUp,
    }
  } catch (err) {
    await cleanUp()
    throw err
  }
}
