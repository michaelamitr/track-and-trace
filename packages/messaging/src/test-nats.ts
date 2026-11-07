// Integration-test helper only; not exported from index.ts.
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { connectNats } from './connection.js'

export type TestNats = {
  nc: NatsConnection
  js: JetStreamClient
  jsm: JetStreamManager
  stop(): Promise<void>
}

/** A fresh JetStream-enabled NATS for one test file, never the compose one. */
export async function startNats(): Promise<TestNats> {
  const container: StartedTestContainer = await new GenericContainer('nats:2.14-alpine')
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
