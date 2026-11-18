import { LogisticsEventSchema } from '@tt/contracts'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createIngestScan } from '../application/ingest-scan.js'
import { buildApp } from './app.js'

const NOW = new Date('2026-10-28T09:31:12Z')

const body = {
  eventId: '4D36957B-6C2B-47E0-B784-13A9B00C0B67',
  shipmentId: '0D40C8BB-E48F-4311-9223-1A54A7E197E4',
  type: 'ARRIVED_AT_HUB',
  occurredAt: '2026-10-28T09:30:00Z',
  facilityId: 'DEPOT-BRNO',
  scannerId: 'SCANNER-17',
}

const expectedEvent = {
  eventId: '4d36957b-6c2b-47e0-b784-13a9b00c0b67',
  eventType: 'parcel.arrived_at_hub',
  eventVersion: 1,
  shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
  occurredAt: '2026-10-28T09:30:00Z',
  receivedAt: '2026-10-28T09:31:12Z',
  correlationId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
  causationId: null,
  producer: 'scan-ingestion',
  data: { facilityId: 'DEPOT-BRNO', scannerId: 'SCANNER-17' },
}

const publish = vi.fn()
const checkReadiness = vi.fn()
let logLines: Record<string, unknown>[]
let app: FastifyInstance

beforeEach(async () => {
  vi.resetAllMocks()
  publish.mockResolvedValue({ seq: 1, duplicate: false })
  logLines = []
  const logger = pino({ level: 'info' }, { write: (line: string) => logLines.push(JSON.parse(line)) })
  app = await buildApp({ ingestScan: createIngestScan({ publish }), checkReadiness, now: () => NOW, logger })
})

afterEach(async () => {
  await app.close()
})

function post(payload: unknown) {
  return app.inject({ method: 'POST', url: '/scans', payload: payload as object })
}

function errorPaths(res: { json(): { error: { details?: { path: string }[] } } }) {
  return res.json().error.details?.map((d) => d.path).sort()
}

describe('POST /scans', () => {
  it('returns 202 with the lowercase eventId after publishing with deduplicate: false', async () => {
    const res = await post(body)

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ eventId: '4d36957b-6c2b-47e0-b784-13a9b00c0b67' })
    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith(expectedEvent, { deduplicate: false })
    expect(LogisticsEventSchema.parse(publish.mock.calls[0]![0])).toEqual(expectedEvent)
  })

  it('answers only after the publish resolved', async () => {
    let resolvePublish!: () => void
    publish.mockReturnValue(new Promise((resolve) => (resolvePublish = () => resolve({ seq: 1, duplicate: false }))))
    let answered = false

    const pending = post(body).then((res) => {
      answered = true
      return res
    })
    await vi.waitFor(() => expect(publish).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(answered).toBe(false)

    resolvePublish()
    expect((await pending).statusCode).toBe(202)
  })

  it.each([
    ['ACCEPTED', 'parcel.accepted'],
    ['ARRIVED_AT_HUB', 'parcel.arrived_at_hub'],
    ['OUT_FOR_DELIVERY', 'parcel.out_for_delivery'],
    ['DELIVERED', 'parcel.delivered'],
  ])('publishes %s as %s', async (type, eventType) => {
    const res = await post({ ...body, type })

    expect(res.statusCode).toBe(202)
    expect(publish.mock.calls[0]![0].eventType).toBe(eventType)
  })

  it('logs eventId, eventType, shipmentId, correlationId and result on 202', async () => {
    await post(body)

    expect(logLines).toContainEqual(
      expect.objectContaining({
        level: 30,
        msg: 'scan accepted',
        eventId: expectedEvent.eventId,
        eventType: 'parcel.arrived_at_hub',
        shipmentId: expectedEvent.shipmentId,
        correlationId: expectedEvent.shipmentId,
        result: 'accepted',
      }),
    )
  })

  it.each([
    ['eventId', { eventId: 'not-a-uuid' }],
    ['shipmentId', { shipmentId: '' }],
    ['type', { type: 'RETURNED' }],
    ['type', { type: 'parcel.delivered' }],
    ['occurredAt', { occurredAt: '2026-10-28T10:30:00+01:00' }],
    ['occurredAt', { occurredAt: 'yesterday' }],
    ['facilityId', { facilityId: '' }],
    ['facilityId', { facilityId: 'x'.repeat(65) }],
    ['scannerId', { scannerId: 'x'.repeat(65) }],
  ])('returns 400 VALIDATION_ERROR for an invalid %s and publishes nothing', async (field, change) => {
    const res = await post({ ...body, ...change })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    expect(errorPaths(res)).toEqual([`body.${field}`])
    expect(publish).not.toHaveBeenCalled()
  })

  it('accepts facilityId and scannerId of 64 characters', async () => {
    const res = await post({ ...body, facilityId: 'f'.repeat(64), scannerId: 's'.repeat(64) })

    expect(res.statusCode).toBe(202)
  })

  it('returns 400 for a missing field', async () => {
    const { scannerId: _omitted, ...rest } = body

    const res = await post(rest)

    expect(res.statusCode).toBe(400)
    expect(errorPaths(res)).toEqual(['body.scannerId'])
  })

  it('accepts occurredAt exactly 5 minutes after the request arrived', async () => {
    const res = await post({ ...body, occurredAt: '2026-10-28T09:36:12Z' })

    expect(res.statusCode).toBe(202)
  })

  it('returns 400 on body.occurredAt for occurredAt more than 5 minutes in the future', async () => {
    const res = await post({ ...body, occurredAt: '2026-10-28T09:36:12.001Z' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request is invalid.',
        details: [{ path: 'body.occurredAt', message: expect.stringContaining('5 minutes') }],
      },
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it('accepts an occurredAt long in the past', async () => {
    const res = await post({ ...body, occurredAt: '2025-01-01T00:00:00Z' })

    expect(res.statusCode).toBe(202)
  })

  it('returns 400 VALIDATION_ERROR for malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/scans',
      headers: { 'content-type': 'application/json' },
      payload: '{"eventId":',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })

  it.each([
    ['a timeout', Object.assign(new Error('TIMEOUT'), { name: 'TimeoutError' })],
    ['a closed connection', new Error('closed connection')],
    ['no responders', Object.assign(new Error('503'), { name: 'NoRespondersError' })],
    ['a non-Error value', 'boom'],
  ])('returns 503 DEPENDENCY_UNAVAILABLE when the publish fails with %s', async (_label, failure) => {
    publish.mockRejectedValue(failure)

    const res = await post(body)

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'The service is temporarily unavailable. Retry later.' },
    })
  })

  it('logs a warning with eventId, shipmentId, correlationId and the error on 503', async () => {
    publish.mockRejectedValue(new Error('TIMEOUT'))

    await post(body)

    const warning = logLines.find((line) => line.level === 40)
    expect(warning).toMatchObject({
      msg: 'publish failed',
      eventId: expectedEvent.eventId,
      shipmentId: expectedEvent.shipmentId,
      correlationId: expectedEvent.shipmentId,
      err: expect.objectContaining({ message: 'TIMEOUT' }),
    })
    expect(logLines.some((line) => line.result === 'accepted')).toBe(false)
  })

  it('returns 500 INTERNAL_ERROR, not 503, when the event fails validation (a bug)', async () => {
    const zodError = (() => {
      try {
        z.uuid().parse('nope')
      } catch (err) {
        return err
      }
    })()
    publish.mockRejectedValue(zodError)

    const res = await post(body)

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } })
  })
})

describe('other routes', () => {
  it('returns 404 NOT_FOUND for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' })

    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
  })

  it('GET /health/live returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('GET /health/ready returns 200 when NATS is connected', async () => {
    checkReadiness.mockResolvedValue({ nats: true })

    const res = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ready', checks: { nats: 'ok' } })
  })

  it('GET /health/ready returns 503 when NATS is not connected', async () => {
    checkReadiness.mockResolvedValue({ nats: false })

    const res = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'not_ready', checks: { nats: 'failed' } })
  })

  it('serves the OpenAPI document with the scan and health routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' })

    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.json().paths)).toEqual(
      expect.arrayContaining(['/scans', '/health/live', '/health/ready']),
    )
  })
})
