import { describe, expect, it } from 'vitest'
import { shutdown } from './shutdown.js'

describe('shutdown', () => {
  it('stops consuming first and waits for it, then closes HTTP, drains NATS and ends the pool', async () => {
    const order: string[] = []
    const step = (name: string) => async () => {
      order.push(`${name} started`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`${name} done`)
    }

    await shutdown({
      consumer: { stop: step('consumer') },
      app: { close: step('http') },
      nc: { drain: step('nats') },
      pool: { end: step('pool') },
    })

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
})
