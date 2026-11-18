import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { publishEvent } from './publish.js'
import { ensureStream, LOGISTICS_STREAM } from './stream.js'
import { parcelDelivered } from './test-fixtures.js'
import { startNats, type TestNats } from './test-nats.js'

let nats: TestNats

beforeAll(async () => {
  nats = await startNats()
})

afterAll(async () => {
  await nats?.stop()
})

beforeEach(async () => {
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
  await ensureStream(nats.jsm)
})

async function storedMessages() {
  const info = await nats.jsm.streams.info(LOGISTICS_STREAM.name)
  return info.state.messages
}

async function msgIdHeader(seq: number) {
  const msg = await nats.jsm.streams.getMessage(LOGISTICS_STREAM.name, { seq })
  return msg?.header?.get('Nats-Msg-Id') || undefined
}

describe('publishEvent', () => {
  it('stores an event published twice only once', async () => {
    const event = parcelDelivered()

    const first = await publishEvent(nats.js, event)
    const second = await publishEvent(nats.js, event)

    expect(first.duplicate).toBe(false)
    expect(second).toEqual({ seq: first.seq, duplicate: true })
    expect(await storedMessages()).toBe(1)
    expect(await msgIdHeader(first.seq)).toBe(event.eventId)
  })

  it('stores every copy and sets no Nats-Msg-Id with deduplicate: false', async () => {
    const event = parcelDelivered()

    const first = await publishEvent(nats.js, event, { deduplicate: false })
    const second = await publishEvent(nats.js, event, { deduplicate: false })

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(false)
    expect(second.seq).toBe(first.seq + 1)
    expect(await storedMessages()).toBe(2)
    expect(await msgIdHeader(first.seq)).toBeUndefined()
    expect(await msgIdHeader(second.seq)).toBeUndefined()
  })

  it('throws for an invalid event and stores nothing', async () => {
    await expect(publishEvent(nats.js, { ...parcelDelivered(), occurredAt: 'yesterday' })).rejects.toThrow()

    expect(await storedMessages()).toBe(0)
  })
})
