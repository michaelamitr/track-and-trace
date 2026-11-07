import { nanos } from '@nats-io/transport-node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONSUMERS, ensureConsumer, type ConsumerName } from './consumers.js'
import { ensureStream, LOGISTICS_STREAM } from './stream.js'
import { startNats, type TestNats } from './test-nats.js'

let nats: TestNats

beforeAll(async () => {
  nats = await startNats()
})

afterAll(async () => {
  await nats?.stop()
})

describe('ensureStream', () => {
  it('creates the declared config, a second call does not fail', async () => {
    const created = await ensureStream(nats.jsm)

    expect(created.config).toMatchObject({
      name: 'LOGISTICS_EVENTS',
      subjects: ['logistics.>'],
      storage: 'file',
      retention: 'limits',
      duplicate_window: nanos(2 * 60 * 1000),
      max_age: 0,
    })
    await expect(ensureStream(nats.jsm)).resolves.toBeDefined()
  })

  it('updates a drifted stream back to the declared config', async () => {
    await ensureStream(nats.jsm)
    await nats.jsm.streams.update(LOGISTICS_STREAM.name, {
      ...LOGISTICS_STREAM,
      duplicate_window: nanos(10_000),
    })

    const info = await ensureStream(nats.jsm)

    expect(info.config.duplicate_window).toBe(nanos(2 * 60 * 1000))
  })
})

describe('ensureConsumer', () => {
  const names = Object.keys(CONSUMERS) as ConsumerName[]

  it.each(names)('creates durable %s with the declared config, a second call does not fail', async (name) => {
    await ensureStream(nats.jsm)

    const info = await ensureConsumer(nats.jsm, name)

    expect(info.config).toMatchObject({
      durable_name: name,
      filter_subjects: CONSUMERS[name].filter_subjects,
      ack_policy: 'explicit',
      deliver_policy: 'all',
      ack_wait: nanos(30_000),
      max_deliver: 5,
    })
    await expect(ensureConsumer(nats.jsm, name)).resolves.toBeDefined()
  })

  it('updates a drifted consumer back to the declared config', async () => {
    await ensureStream(nats.jsm)
    await ensureConsumer(nats.jsm, 'tracking')
    await nats.jsm.consumers.update(LOGISTICS_STREAM.name, 'tracking', { max_deliver: 10 })

    const info = await ensureConsumer(nats.jsm, 'tracking')

    expect(info.config.max_deliver).toBe(5)
  })
})
