// Integration-test helper only; not exported from index.ts.
import { once } from 'node:events'
import { createServer, type Server } from 'node:net'

// Below the ports that Docker and the OS hand out by themselves (from 32768 on
// Linux, from 49152 on macOS), so nothing takes a reserved port by chance.
const FIRST_PORT = 20_000
const LAST_PORT = 24_999
/** Port P is reserved while a guard listens on P + GUARD_OFFSET. */
const GUARD_OFFSET = 5_000

export type ReservedPort = {
  port: number
  release(): Promise<void>
}

async function listen(port: number): Promise<Server | null> {
  const server = createServer()
  try {
    server.listen(port)
    await once(server, 'listening')
    // The guard does not keep the process running.
    server.unref()
    return server
  } catch (err) {
    if ((err as { code?: unknown }).code === 'EADDRINUSE') return null
    throw err
  }
}

async function close(server: Server): Promise<void> {
  server.close()
  await once(server, 'close')
}

/**
 * Reserves a host port for a container that is stopped and started again: no
 * other call gets it, in this or another process, even while nothing listens
 * on it. The guard is a socket, so a crashed process releases its ports.
 */
export async function reservePort(): Promise<ReservedPort> {
  const count = LAST_PORT - FIRST_PORT + 1
  const start = Math.floor(Math.random() * count)
  for (let i = 0; i < count; i++) {
    const port = FIRST_PORT + ((start + i) % count)
    const guard = await listen(port + GUARD_OFFSET)
    if (!guard) continue
    const probe = await listen(port)
    if (probe) {
      await close(probe)
      return { port, release: () => close(guard) }
    }
    // Something else (not a test) uses the port.
    await close(guard)
  }
  throw new Error(`No free port between ${FIRST_PORT} and ${LAST_PORT}`)
}
