import { once } from 'node:events'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reservePort, type ReservedPort } from './test-port.js'

const reserved: ReservedPort[] = []

async function reserve() {
  const port = await reservePort()
  reserved.push(port)
  return port
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(reserved.splice(0).map((port) => port.release()))
})

describe('reservePort', () => {
  it('reserves a port below the ones Docker and the OS hand out, and leaves it free to bind', async () => {
    const { port } = await reserve()

    expect(port).toBeGreaterThanOrEqual(20_000)
    expect(port).toBeLessThan(32_768)
    const server = createServer().listen(port)
    await once(server, 'listening')
    server.close()
    await once(server, 'close')
  })

  it('does not give a reserved port again, although nothing listens on it, until it is released', async () => {
    // Every call starts its search at the same port.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const first = await reserve()

    expect((await reserve()).port).not.toBe(first.port)

    await first.release()
    reserved.splice(reserved.indexOf(first), 1)
    expect((await reserve()).port).toBe(first.port)
  })

  it('skips a port that something else uses', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const first = await reservePort()
    await first.release()
    const server = createServer().listen(first.port)
    await once(server, 'listening')
    try {
      expect((await reserve()).port).not.toBe(first.port)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})
