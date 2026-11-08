// Integration-test helper only; not exported from index.ts.
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { connectNats } from './connection.js'

/** Must match the nats service image in compose.yaml (checked by test-nats.test.ts). */
export const NATS_IMAGE = 'nats:2.14-alpine'

export type TestNats = {
  nc: NatsConnection
  js: JetStreamClient
  jsm: JetStreamManager
  stop(): Promise<void>
}

/** A fresh JetStream-enabled NATS for one test file, never the compose one. */
export async function startNats(): Promise<TestNats> {
  const container: StartedTestContainer = await new GenericContainer(NATS_IMAGE)
    .withCommand(['-js'])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start()
  const nc = await connectNats(`nats://${container.getHost()}:${container.getMappedPort(4222)}`)
  return {
    nc,
    js: jetstream(nc),
    jsm: await jetstreamManager(nc),
    async stop() {
      await nc.close()
      await container.stop()
    },
  }
}
