import type { NatsConnection } from '@nats-io/transport-node'
import { describe, expect, it, vi } from 'vitest'
import { shutdown } from './shutdown.js'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe('shutdown', () => {
  it('stops consuming first and waits for it, then closes HTTP, drains NATS and ends the pool; exit code 0', async () => {
    const order: string[] = []
    const step = (name: string) => async () => {
      order.push(`${name} started`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`${name} done`)
    }
    const nc = { isClosed: () => false, drain: step('nats'), close: vi.fn() } as unknown as NatsConnection

    const code = await shutdown(
      { consumer: { stop: step('consumer') }, app: { close: step('http') }, nc, pool: { end: step('pool') } },
      log,
    )

    expect(code).toBe(0)
    expect(order).toEqual([
      'consumer started',
      'consumer done',
      'http started',
      'http done',
      'nats started',
      'nats done',
      'pool started',
      'pool done',
    ])
  })

  it('resolves to 1 when the deadline passes', async () => {
    const nc = { isClosed: () => true } as unknown as NatsConnection
    const stuck = { stop: () => new Promise<void>(() => {}) }

    const code = await shutdown(
      { consumer: stuck, app: { close: async () => {} }, nc, pool: { end: async () => {} } },
      log,
      50,
    )

    expect(code).toBe(1)
  })
})
