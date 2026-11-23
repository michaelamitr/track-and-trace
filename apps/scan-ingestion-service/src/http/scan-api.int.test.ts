import { randomUUID } from 'node:crypto'
import { jetstream } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import { connectNats, ensureStream, LOGISTICS_STREAM, publishEvent } from '@tt/messaging'
import { startNats, type TestNats } from '@tt/messaging/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIngestScan } from '../application/ingest-scan.js'
import { createHealthChecks } from '../health.js'
import { streamMessages } from '../test-support.js'
import { buildApp } from './app.js'

const NOW = new Date('2026-10-28T09:31:12Z')

let nats: TestNats
// The service's own connection, configured like main.ts (never stops reconnecting).
let serviceNc: NatsConnection
let app: FastifyInstance

beforeAll(async () => {
  nats = await startNats({ restartable: true })
  serviceNc = await connectNats(nats.url, { maxReconnectAttempts: -1, reconnectTimeWait: 200 })
  // A short publish timeout keeps the NATS-down test short; main.ts uses the client default.
  const js = jetstream(serviceNc, { timeout: 1_000 })
  app = await buildApp({
    ingestScan: createIngestScan({ publish: (event, options) => publishEvent(js, event, options) }),
    checks: createHealthChecks({ nc: serviceNc }),
    now: () => NOW,
    logger: false,
  })
})

afterAll(async () => {
  await app?.close()
  await serviceNc?.close()
  await nats?.stop()
})

beforeEach(async () => {
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
  await ensureStream(nats.jsm)
})

function newBody(overrides: Record<string, string> = {}) {
  return {
    eventId: randomUUID().toUpperCase(),
    shipmentId: randomUUID(),
    type: 'ARRIVED_AT_HUB',
    occurredAt: '2026-10-28T09:30:00Z',
    facilityId: 'DEPOT-BRNO',
    scannerId: 'SCANNER-17',
    ...overrides,
  }
}

function post(body: object) {
  return app.inject({ method: 'POST', url: '/scans', payload: body })
}

describe('POST /scans', () => {
  it('publishes one message on the event subject with the expected envelope and no Nats-Msg-Id', async () => {
    const body = newBody()
    const eventId = body.eventId.toLowerCase()

    const res = await post(body)

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ eventId })
    const messages = await streamMessages(nats.jsm)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.subject).toBe('logistics.parcel.arrived_at_hub.v1')
    expect(messages[0]?.msgId).toBeUndefined()
    expect(messages[0]?.event).toEqual({
      eventId,
      eventType: 'parcel.arrived_at_hub',
      eventVersion: 1,
      shipmentId: body.shipmentId,
      occurredAt: body.occurredAt,
      receivedAt: '2026-10-28T09:31:12Z',
      correlationId: body.shipmentId,
      causationId: null,
      producer: 'scan-ingestion',
      data: { facilityId: 'DEPOT-BRNO', scannerId: 'SCANNER-17' },
    })
  })

  it('stores two messages for two identical requests (no broker deduplication, ADR-0010)', async () => {
    const body = newBody({ type: 'DELIVERED' })

    const first = await post(body)
    const second = await post(body)

    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(202)
    const messages = await streamMessages(nats.jsm)
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.subject)).toEqual(['logistics.parcel.delivered.v1', 'logistics.parcel.delivered.v1'])
    expect(messages.map((m) => m.event.eventId)).toEqual([body.eventId.toLowerCase(), body.eventId.toLowerCase()])
    expect(messages.every((m) => m.msgId === undefined)).toBe(true)
  })

  it('returns 400 and stores nothing for an occurredAt too far in the future', async () => {
    const res = await post(newBody({ occurredAt: '2026-10-28T09:36:13Z' }))

    expect(res.statusCode).toBe(400)
    expect(await streamMessages(nats.jsm)).toEqual([])
  })

  it('returns 503 when the stream is missing', async () => {
    await nats.jsm.streams.delete(LOGISTICS_STREAM.name)

    const res = await post(newBody())

    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('DEPENDENCY_UNAVAILABLE')
  })

  it('GET /health/ready returns 200 while NATS is connected', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ready', checks: { nats: 'ok' } })
  })

  it('AC-07: answers 503 while NATS is down; the retry with the same eventId succeeds after recovery', async () => {
    const body = newBody()
    await nats.stopServer()
    try {
      const ready = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(ready.statusCode).toBe(503)
      expect(ready.json()).toEqual({ status: 'not_ready', checks: { nats: 'failed' } })

      const res = await post(body)
      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('DEPENDENCY_UNAVAILABLE')
    } finally {
      await nats.startServer()
    }

    // Like a scanner: retry the same scan until it is accepted. /health/ready (core NATS) can
    // turn green before JetStream has recovered, so the first retries may still get 503.
    await vi.waitFor(
      async () => {
        expect((await post(body)).statusCode).toBe(202)
      },
      { timeout: 30_000, interval: 500 },
    )
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200)

    const messages = await streamMessages(nats.jsm)
    // The retry is stored. The publish that got 503 may also have been stored if the client
    // flushed it on reconnect; consumers deduplicate such copies by eventId (ADR-0010).
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(messages.every((m) => m.event.eventId === body.eventId.toLowerCase())).toBe(true)
  }, 60_000)
})
