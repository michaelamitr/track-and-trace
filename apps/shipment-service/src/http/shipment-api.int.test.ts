import { jetstream, type JetStreamClient } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import { connectNats, ensureStream, LOGISTICS_STREAM } from '@tt/messaging'
import { startNats, type TestNats } from '@tt/messaging/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGetShipment } from '../application/get-shipment.js'
import { createRegisterShipment } from '../application/register-shipment.js'
import { createPool } from '../db/pool.js'
import { createReadinessCheck } from '../health.js'
import { startOutboxRelay, type OutboxRelay } from '../outbox/relay.js'
import { outboxRows, quietLog, startTestDatabase, streamMessages, type TestDatabase } from '../test-support.js'
import { buildApp } from './app.js'

let db: TestDatabase
let nats: TestNats
// The service's own connection, configured like main.ts (never stops reconnecting).
let serviceNc: NatsConnection
let serviceJs: JetStreamClient
let app: FastifyInstance
let relay: OutboxRelay | undefined

beforeAll(async () => {
  ;[db, nats] = await Promise.all([startTestDatabase(), startNats({ restartable: true })])
  serviceNc = await connectNats(nats.url, { maxReconnectAttempts: -1, reconnectTimeWait: 200 })
  // A short publish timeout keeps failed relay rounds short while NATS is down.
  serviceJs = jetstream(serviceNc, { timeout: 1_000 })
  app = await buildApp({
    registerShipment: createRegisterShipment({ pool: db.pool }),
    getShipment: createGetShipment({ pool: db.pool }),
    checkReadiness: createReadinessCheck({ pool: db.pool, nc: serviceNc }),
    logger: false,
  })
})

afterAll(async () => {
  await app?.close()
  await serviceNc?.close()
  await Promise.all([db?.stop(), nats?.stop()])
})

beforeEach(async () => {
  await db.pool.query('DELETE FROM outbox')
  await db.pool.query('DELETE FROM shipments')
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
  await ensureStream(nats.jsm)
})

afterEach(async () => {
  await relay?.stop()
  relay = undefined
})

function startRelay() {
  relay = startOutboxRelay({ pool: db.pool, js: serviceJs, intervalMs: 50, maxBackoffMs: 500, log: quietLog })
}

let orderSeq = 0
function newBody(overrides: Record<string, string> = {}) {
  orderSeq += 1
  return {
    orderReference: `ESHOP-${Date.now()}-${orderSeq}`,
    originFacilityId: 'PRG-HUB-01',
    destination: 'Brno',
    recipientId: 'cust-88231',
    expectedDeliveryAt: '2026-11-11T16:00:00Z',
    ...overrides,
  }
}

function post(body: object) {
  return app.inject({ method: 'POST', url: '/shipments', payload: body })
}

async function shipmentRows() {
  return (await db.pool.query('SELECT * FROM shipments ORDER BY order_reference')).rows
}

async function waitUntilPublished(count: number, timeout = 10_000) {
  await vi.waitFor(
    async () => {
      const rows = await outboxRows(db.pool)
      expect(rows).toHaveLength(count)
      expect(rows.every((row) => row.published_at !== null)).toBe(true)
    },
    { timeout, interval: 50 },
  )
}

describe('POST /shipments', () => {
  it('creates the shipment and one outbox row; the relay publishes exactly that payload', async () => {
    const body = newBody()

    const res = await post(body)

    expect(res.statusCode).toBe(201)
    const created = res.json()
    expect(created).toEqual({ ...body, shipmentId: expect.any(String), trackingNumber: expect.stringMatching(/^PF-\d{10}$/) })

    const [shipment] = await shipmentRows()
    const [row, ...others] = await outboxRows(db.pool)
    expect(others).toEqual([])
    expect(row?.published_at).toBeNull()
    expect(row?.event_id).toBe(shipment.registered_event_id)
    expect(row?.subject).toBe('logistics.shipment.registered.v1')
    expect(row?.payload).toEqual({
      eventId: shipment.registered_event_id,
      eventType: 'shipment.registered',
      eventVersion: 1,
      shipmentId: created.shipmentId,
      occurredAt: shipment.registered_at.toISOString().replace('.000Z', 'Z'),
      receivedAt: shipment.registered_at.toISOString().replace('.000Z', 'Z'),
      correlationId: created.shipmentId,
      causationId: null,
      producer: 'shipment',
      data: {
        trackingNumber: created.trackingNumber,
        originFacilityId: body.originFacilityId,
        destination: body.destination,
        recipientId: body.recipientId,
        expectedDeliveryAt: body.expectedDeliveryAt,
      },
    })

    startRelay()
    await waitUntilPublished(1)

    const messages = await streamMessages(nats.jsm)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.subject).toBe(row?.subject)
    expect(messages[0]?.event).toEqual(row?.payload)
    // Duplicate detection on the stream relies on Nats-Msg-Id = eventId (ADR-0006).
    expect(messages[0]?.msgId).toBe(row?.event_id)

    const fetched = await app.inject({ method: 'GET', url: `/shipments/${created.shipmentId}` })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.json()).toEqual(created)
  })

  it('returns 200 with the same shipment for the same request again and adds no outbox row', async () => {
    const body = newBody()
    const first = await post(body)

    const second = await post(body)
    // The same instant written differently is the same data.
    const third = await post({ ...body, expectedDeliveryAt: '2026-11-11T16:00:00.000Z' })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    expect(third.statusCode).toBe(200)
    expect(second.json()).toEqual(first.json())
    expect(third.json()).toEqual(first.json())
    expect(await shipmentRows()).toHaveLength(1)
    expect(await outboxRows(db.pool)).toHaveLength(1)
  })

  it.each([
    ['destination', { destination: 'Ostrava' }],
    ['expectedDeliveryAt', { expectedDeliveryAt: '2026-11-11T16:00:01Z' }],
  ])('returns 409 for the same orderReference with a different %s and changes nothing', async (_field, change) => {
    const body = newBody()
    await post(body)
    const shipmentsBefore = await shipmentRows()
    const outboxBefore = await outboxRows(db.pool)

    const res = await post({ ...body, ...change })

    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('ORDER_CONFLICT')
    expect(await shipmentRows()).toEqual(shipmentsBefore)
    expect(await outboxRows(db.pool)).toEqual(outboxBefore)
  })

  it('handles identical requests in parallel: one 201, the rest 200, one outbox row', async () => {
    const body = newBody()

    const responses = await Promise.all(Array.from({ length: 10 }, () => post(body)))

    const statuses = responses.map((res) => res.statusCode).sort()
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201])
    const ids = new Set(responses.map((res) => res.json().shipmentId))
    expect(ids.size).toBe(1)
    expect(await shipmentRows()).toHaveLength(1)
    expect(await outboxRows(db.pool)).toHaveLength(1)
  })

  it('saves neither the shipment nor the event if the outbox row cannot be written', async () => {
    // Make the outbox insert fail; the shipment insert in the same transaction must roll back.
    await db.owner.query('REVOKE INSERT ON outbox FROM shipment_service')
    try {
      const res = await post(newBody())

      expect(res.statusCode).toBe(500)
      expect(await shipmentRows()).toEqual([])
      expect(await outboxRows(db.pool)).toEqual([])
    } finally {
      await db.owner.query('GRANT INSERT ON outbox TO shipment_service')
    }
  })

  it('AC-06: accepts registrations while NATS is down and publishes them after recovery', async () => {
    startRelay()
    await nats.stopServer()
    try {
      const ready = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(ready.statusCode).toBe(503)
      expect(ready.json().checks).toEqual({ database: 'ok', nats: 'failed' })

      const res = await post(newBody())
      expect(res.statusCode).toBe(201)

      // Give the relay a few failed rounds; nothing may be marked as published.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      const [row] = await outboxRows(db.pool)
      expect(row?.published_at).toBeNull()
    } finally {
      await nats.startServer()
    }

    await waitUntilPublished(1, 30_000)
    const [row] = await outboxRows(db.pool)
    const messages = await streamMessages(nats.jsm)
    expect(messages.map((m) => m.event)).toEqual([row?.payload])

    await vi.waitFor(async () => {
      expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200)
    })
  }, 60_000)
})

describe('GET /shipments/:shipmentId', () => {
  it('returns 404 for an unknown shipment', async () => {
    const res = await app.inject({ method: 'GET', url: '/shipments/0d40c8bb-e48f-4311-9223-1a54a7e197e4' })

    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
  })
})

describe('tracking number collisions', () => {
  it('retries with a new tracking number when the generated one is taken', async () => {
    const taken = (await post(newBody())).json().trackingNumber
    const generate = vi.fn().mockReturnValueOnce(taken).mockReturnValueOnce('PF-0000000001')
    const register = createRegisterShipment({ pool: db.pool, generateTrackingNumber: generate })

    const result = await register({ ...newBody(), expectedDeliveryAt: new Date('2026-11-11T16:00:00Z') })

    expect(result.status).toBe('created')
    expect(result.shipment.trackingNumber).toBe('PF-0000000001')
    expect(generate).toHaveBeenCalledTimes(2)
    expect(await outboxRows(db.pool)).toHaveLength(2)
  })

  it('gives up after three taken tracking numbers', async () => {
    const taken = (await post(newBody())).json().trackingNumber
    const generate = vi.fn().mockReturnValue(taken)
    const register = createRegisterShipment({ pool: db.pool, generateTrackingNumber: generate })

    await expect(
      register({ ...newBody(), expectedDeliveryAt: new Date('2026-11-11T16:00:00Z') }),
    ).rejects.toMatchObject({ code: '23505' })
    expect(generate).toHaveBeenCalledTimes(3)
    expect(await shipmentRows()).toHaveLength(1)
  })
})

describe('database unavailable', () => {
  it('returns 503 DEPENDENCY_UNAVAILABLE', async () => {
    // Nothing listens on port 1.
    const deadPool = createPool('postgres://shipment_service:x@127.0.0.1:1/shipment_db')
    const deadApp = await buildApp({
      registerShipment: createRegisterShipment({ pool: deadPool }),
      getShipment: createGetShipment({ pool: deadPool }),
      checkReadiness: createReadinessCheck({ pool: deadPool, nc: serviceNc }),
      logger: false,
    })
    try {
      const posted = await deadApp.inject({ method: 'POST', url: '/shipments', payload: newBody() })
      const fetched = await deadApp.inject({ method: 'GET', url: '/shipments/0d40c8bb-e48f-4311-9223-1a54a7e197e4' })
      const ready = await deadApp.inject({ method: 'GET', url: '/health/ready' })

      expect(posted.statusCode).toBe(503)
      expect(posted.json().error.code).toBe('DEPENDENCY_UNAVAILABLE')
      expect(fetched.statusCode).toBe(503)
      expect(ready.json().checks).toEqual({ database: 'failed', nats: 'ok' })
    } finally {
      await deadApp.close()
      await deadPool.end()
    }
  })
})
