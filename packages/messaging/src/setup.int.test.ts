import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CONSUMERS, type ConsumerName } from './consumers.js'
import { setupNats, verifyConsumer, verifyStream } from './setup.js'
import { LOGISTICS_STREAM } from './stream.js'
import { startNats, type TestNats } from './test-nats.js'

let nats: TestNats
const names = Object.keys(CONSUMERS) as ConsumerName[]

beforeAll(async () => {
  nats = await startNats()
})

afterAll(async () => {
  await nats?.stop()
})

beforeEach(async () => {
  // Deleting the stream also deletes its consumers.
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
})

describe('before setup', () => {
  it('verifyStream throws a clear error', async () => {
    await expect(verifyStream(nats.jsm)).rejects.toThrow(
      'Stream LOGISTICS_EVENTS not found. Run `pnpm nats:setup` first.',
    )
  })

  it('verifyConsumer throws a clear error naming the consumer', async () => {
    await expect(verifyConsumer(nats.jsm, 'tracking')).rejects.toThrow(
      'Consumer tracking on stream LOGISTICS_EVENTS not found. Run `pnpm nats:setup` first.',
    )
  })
})

describe('setupNats', () => {
  it('creates the stream and all three consumers, a second call does not fail', async () => {
    await setupNats(nats.jsm)

    await expect(nats.jsm.streams.info(LOGISTICS_STREAM.name)).resolves.toBeDefined()
    const consumers = await nats.jsm.consumers.list(LOGISTICS_STREAM.name).next()
    expect(consumers.map((c) => c.name).sort()).toEqual([...names].sort())
    expect(names).toHaveLength(3)

    await expect(setupNats(nats.jsm)).resolves.toBeUndefined()
  })

  it('makes verifyStream and verifyConsumer pass', async () => {
    await setupNats(nats.jsm)

    await expect(verifyStream(nats.jsm)).resolves.toBeUndefined()
    for (const name of names) {
      await expect(verifyConsumer(nats.jsm, name)).resolves.toBeUndefined()
    }
  })
})
