import { connect } from 'node:net'
import type { NatsConnection } from '@nats-io/transport-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectNats } from './connection.js'
import { publishEvent } from './publish.js'
import { ensureStream } from './stream.js'
import { parcelDelivered } from './test-fixtures.js'
import { startNats, type TestNats } from './test-nats.js'
import { streamMessages } from './test-stream.js'

const servers: TestNats[] = []
const connections: NatsConnection[] = []

async function start(options: { restartable?: boolean } = {}) {
  const nats = await startNats(options)
  servers.push(nats)
  return nats
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map((nc) => nc.close()))
  await Promise.all(servers.splice(0).map((nats) => nats.stop()))
})

/** The id of the NATS server that answers at the URL, or undefined. */
function serverIdAt(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const { hostname, port } = new URL(url)
    const socket = connect(Number(port), hostname)
    let received = ''
    const finish = (id?: string) => {
      socket.destroy()
      resolve(id)
    }
    socket.on('data', (chunk) => {
      received += chunk
      const id = /"server_id":"([^"]+)"/.exec(received)?.[1]
      if (id) finish(id)
    })
    socket.on('error', () => finish())
    socket.on('close', () => finish())
    socket.setTimeout(5_000, () => finish())
  })
}

describe('startNats({ restartable: true })', () => {
  it('keeps the host port and the JetStream data after a restart, and reconnects clients', async () => {
    const nats = await start({ restartable: true })
    const client = await connectNats(nats.url, { maxReconnectAttempts: -1, reconnectTimeWait: 100 })
    connections.push(client)
    await ensureStream(nats.jsm)
    const event = parcelDelivered()
    await publishEvent(nats.js, event)
    const before = await nats.placement()
    expect(before.hostPorts).toEqual([new URL(nats.url).port])

    await nats.stopServer()
    expect((await nats.placement()).hostPorts).toEqual([])
    await nats.startServer()

    // The binding in Docker, not the URL, which is never changed.
    expect((await nats.placement()).hostPorts).toEqual(before.hostPorts)
    // startServer() resolves only when the helper's own connection works again.
    expect((await streamMessages(nats.jsm)).map((message) => message.event)).toEqual([event])
    const other = await connectNats(nats.url)
    connections.push(other)
    expect(other.info?.server_id).toBe(nats.nc.info?.server_id)
    // This client reconnects on its own schedule; rtt() fails until it has.
    await vi.waitFor(() => client.rtt(), { timeout: 10_000, interval: 50 })
    expect(client.info?.server_id).toBe(nats.nc.info?.server_id)
  })

  it('never lets a client reach another server while it is stopped', async () => {
    const nats = await start({ restartable: true })
    const ids: Promise<string | undefined>[] = []
    let dialing = true
    // Dial all the time, so that some connections are pending when the container goes away.
    const dialer = (async () => {
      while (dialing) {
        ids.push(serverIdAt(nats.url))
        await new Promise((resolve) => setTimeout(resolve, 3))
      }
    })()
    const own = nats.nc.info?.server_id
    expect(own).toBeDefined()

    await nats.stopServer()
    // These would get the IP of the stopped container in the shared Docker network.
    const others = await Promise.all([start(), start(), start()])
    await new Promise((resolve) => setTimeout(resolve, 500))
    dialing = false
    await dialer

    const seen = new Set((await Promise.all(ids)).filter((id) => id !== undefined))
    expect(others.map((other) => other.nc.info?.server_id)).not.toContain(own)
    expect([...seen]).toEqual([own])
  })

  it('runs alone in its own network, on a port no other restartable server has', async () => {
    const [first, second] = await Promise.all([start({ restartable: true }), start({ restartable: true })])
    const [a, b] = [await first!.placement(), await second!.placement()]

    expect(a.networks).toHaveLength(1)
    expect(a.networks).not.toContain('bridge')
    expect(b.networks).not.toEqual(a.networks)
    expect(b.hostPorts).not.toEqual(a.hostPorts)
  })
})

it('a server that is not restartable cannot be stopped or started', async () => {
  const nats = await start()

  await expect(nats.stopServer()).rejects.toThrow('restartable: true')
  await expect(nats.startServer()).rejects.toThrow('restartable: true')
})
