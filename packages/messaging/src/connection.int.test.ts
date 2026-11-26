import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeNats, connectNats } from './connection.js'
import { startNats, type TestNats } from './test-nats.js'

let nats: TestNats

beforeAll(async () => {
  nats = await startNats({ restartable: true })
})

afterAll(async () => {
  await nats?.stop()
})

describe('closeNats', () => {
  it('drains a connected client', async () => {
    const nc = await connectNats(nats.url)
    const log = { warn: vi.fn() }

    await closeNats(nc, { log })

    expect(nc.isClosed()).toBe(true)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('closes without draining when NATS is unavailable, and does not reject', async () => {
    const nc = await connectNats(nats.url, { maxReconnectAttempts: -1, reconnectTimeWait: 100 })
    const log = { warn: vi.fn() }
    await nats.stopServer()
    try {
      const started = Date.now()
      await expect(closeNats(nc, { log, drainTimeoutMs: 500 })).resolves.toBeUndefined()

      expect(Date.now() - started).toBeLessThan(2_000)
      expect(nc.isClosed()).toBe(true)
      expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'NATS drain failed, closing the connection')
    } finally {
      await nats.startServer()
    }
  })

  it('does nothing for a closed connection', async () => {
    const nc = await connectNats(nats.url)
    await nc.close()

    await expect(closeNats(nc)).resolves.toBeUndefined()
  })
})
