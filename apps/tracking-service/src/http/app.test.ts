import { DatabaseUnavailableError } from '@tt/db'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredHistoryEntry, TrackingState } from '../domain/tracking-view.js'
import { buildApp } from './app.js'

const SHIPMENT_ID = '0d40c8bb-e48f-4311-9223-1a54a7e197e4'

const state: TrackingState = {
  shipmentId: SHIPMENT_ID,
  trackingNumber: 'PF-4821093375',
  status: 'AT_HUB',
  lastLocation: 'DEPOT-BRNO',
  lastEventAt: new Date('2026-10-28T09:30:00Z'),
  deliveredAt: null,
  updatedAt: new Date('2026-10-28T09:31:13.204Z'),
}

const registration: StoredHistoryEntry = {
  eventId: '5b3f7d0e-2c1a-4e8b-9f6d-3a2b1c0d9e8f',
  eventType: 'shipment.registered',
  status: 'REGISTERED',
  occurredAt: new Date('2026-10-28T08:00:00Z'),
  receivedAt: new Date('2026-10-28T08:00:00Z'),
  facilityId: null,
  isAnomaly: false,
}

const atHub: StoredHistoryEntry = {
  eventId: '4d36957b-6c2b-47e0-b784-13a9b00c0b67',
  eventType: 'parcel.arrived_at_hub',
  status: 'AT_HUB',
  // Whole seconds and milliseconds: both have the same format in the response.
  occurredAt: new Date('2026-10-28T09:30:00Z'),
  receivedAt: new Date('2026-10-28T09:31:12.345Z'),
  facilityId: 'DEPOT-BRNO',
  isAnomaly: false,
}

const atHubResponse = {
  eventId: atHub.eventId,
  eventType: 'parcel.arrived_at_hub',
  status: 'AT_HUB',
  occurredAt: '2026-10-28T09:30:00.000Z',
  receivedAt: '2026-10-28T09:31:12.345Z',
  facilityId: 'DEPOT-BRNO',
  isAnomaly: false,
}

const getTracking = vi.fn()
const getHistory = vi.fn()
const getAnomalies = vi.fn()
const listQuarantine = vi.fn()
const checks = { database: vi.fn(), nats: vi.fn() }
let app: FastifyInstance

beforeEach(async () => {
  vi.resetAllMocks()
  checks.database.mockResolvedValue(undefined)
  checks.nats.mockResolvedValue(undefined)
  app = await buildApp({ getTracking, getHistory, getAnomalies, listQuarantine, checks, logger: false })
})

afterEach(async () => {
  await app.close()
})

function get(url: string) {
  return app.inject({ method: 'GET', url })
}

describe('GET /tracking/:shipmentId', () => {
  it('returns the state with all times as Date.toISOString()', async () => {
    getTracking.mockResolvedValue(state)

    const res = await get(`/tracking/${SHIPMENT_ID}`)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      shipmentId: SHIPMENT_ID,
      trackingNumber: 'PF-4821093375',
      status: 'AT_HUB',
      lastLocation: 'DEPOT-BRNO',
      lastEventAt: '2026-10-28T09:30:00.000Z',
      deliveredAt: null,
      updatedAt: '2026-10-28T09:31:13.204Z',
    })
  })

  it('returns deliveredAt of a delivered shipment', async () => {
    getTracking.mockResolvedValue({ ...state, status: 'DELIVERED', deliveredAt: new Date('2026-10-28T14:00:00Z') })

    const res = await get(`/tracking/${SHIPMENT_ID}`)

    expect(res.json()).toMatchObject({ status: 'DELIVERED', deliveredAt: '2026-10-28T14:00:00.000Z' })
  })
})

describe('GET /tracking/:shipmentId/history', () => {
  it('returns the entries in the given order', async () => {
    getHistory.mockResolvedValue({ shipmentId: SHIPMENT_ID, events: [registration, atHub] })

    const res = await get(`/tracking/${SHIPMENT_ID}/history`)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      shipmentId: SHIPMENT_ID,
      events: [
        {
          eventId: registration.eventId,
          eventType: 'shipment.registered',
          status: 'REGISTERED',
          occurredAt: '2026-10-28T08:00:00.000Z',
          receivedAt: '2026-10-28T08:00:00.000Z',
          facilityId: null,
          isAnomaly: false,
        },
        atHubResponse,
      ],
    })
  })
})

describe('GET /tracking/:shipmentId/anomalies', () => {
  it('returns both lists', async () => {
    const conflict = { eventId: atHub.eventId, streamSequence: 1042, differingFields: ['data.scannerId'] }
    getAnomalies.mockResolvedValue({
      shipmentId: SHIPMENT_ID,
      afterDelivery: [{ ...atHub, isAnomaly: true }],
      conflicts: [{ ...conflict, receivedAt: new Date('2026-10-28T10:02:41Z') }],
    })

    const res = await get(`/tracking/${SHIPMENT_ID}/anomalies`)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      shipmentId: SHIPMENT_ID,
      afterDelivery: [{ ...atHubResponse, isAnomaly: true }],
      conflicts: [{ ...conflict, receivedAt: '2026-10-28T10:02:41.000Z' }],
    })
  })

  it('returns empty lists when there is nothing to report', async () => {
    const nothing = { shipmentId: SHIPMENT_ID, afterDelivery: [], conflicts: [] }
    getAnomalies.mockResolvedValue(nothing)

    const res = await get(`/tracking/${SHIPMENT_ID}/anomalies`)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(nothing)
  })
})

// The fake reads of `echo` return the id they get, so the response shows what the route passed on.
describe.each([
  { suffix: '', read: getTracking, echo: (shipmentId: string) => ({ ...state, shipmentId }) },
  { suffix: '/history', read: getHistory, echo: (shipmentId: string) => ({ shipmentId, events: [] }) },
  {
    suffix: '/anomalies',
    read: getAnomalies,
    echo: (shipmentId: string) => ({ shipmentId, afterDelivery: [], conflicts: [] }),
  },
])('GET /tracking/:shipmentId$suffix: letter case and errors', ({ suffix, read, echo }) => {
  it.each([
    ['uppercase', SHIPMENT_ID.toUpperCase()],
    ['mixed case', SHIPMENT_ID.replace('d', 'D')],
  ])('accepts a shipmentId in %s, reads and returns it in lowercase', async (_label, shipmentId) => {
    read.mockImplementation(async (id: string) => echo(id))

    const res = await get(`/tracking/${shipmentId}${suffix}`)

    expect(res.statusCode).toBe(200)
    expect(read).toHaveBeenCalledExactlyOnceWith(SHIPMENT_ID)
    expect(res.json().shipmentId).toBe(SHIPMENT_ID)
  })

  it('returns 400 VALIDATION_ERROR for an id that is not a UUID and reads nothing', async () => {
    const res = await get(`/tracking/not-a-uuid${suffix}`)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request is invalid.',
        details: [{ path: 'params.shipmentId', message: expect.any(String) }],
      },
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('returns 404 NOT_FOUND for an unknown shipment', async () => {
    read.mockResolvedValue(null)

    const res = await get(`/tracking/${SHIPMENT_ID}${suffix}`)

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Shipment ${SHIPMENT_ID} not found.` } })
  })

  it('returns 503 DEPENDENCY_UNAVAILABLE when the database is unavailable', async () => {
    read.mockRejectedValue(new DatabaseUnavailableError({ cause: new Error('ECONNREFUSED secret-host') }))

    const res = await get(`/tracking/${SHIPMENT_ID}${suffix}`)

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'The service is temporarily unavailable. Retry later.' },
    })
  })

  it('returns 500 INTERNAL_ERROR without internal details for any other error', async () => {
    read.mockRejectedValue(new Error('relation "shipment_tracking" does not exist at secret-host'))

    const res = await get(`/tracking/${SHIPMENT_ID}${suffix}`)

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } })
  })
})

describe('GET /quarantine', () => {
  const stored = {
    id: 7,
    reason: 'INVALID',
    subject: 'logistics.parcel.arrived_at_hub.v1',
    streamSequence: 1057,
    eventId: 'c1a7f0de-9b1e-4c55-8f0e-2d6b7a3e4f10',
    shipmentId: null,
    details: 'shipmentId: Invalid UUID',
    // A BOM, a NUL, a byte that is not UTF-8 and a two-byte character.
    rawMessage: Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x00, 0xff, 0xc3, 0xa9, 0x7d]),
    detectedAt: new Date('2026-11-25T10:14:02.317Z'),
  }

  it('returns the messages with the raw message decoded as UTF-8, invalid bytes replaced', async () => {
    listQuarantine.mockResolvedValue([stored])

    const res = await get('/quarantine')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      messages: [
        {
          ...stored,
          rawMessage: '\uFEFF{\u0000\uFFFDé}',
          detectedAt: '2026-11-25T10:14:02.317Z',
        },
      ],
    })
    expect(listQuarantine).toHaveBeenCalledExactlyOnceWith({ limit: 50 })
  })

  it('returns an empty list', async () => {
    listQuarantine.mockResolvedValue([])

    const res = await get('/quarantine?reason=PROCESSING_FAILED')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ messages: [] })
  })

  it.each([
    ['INVALID', '1', { reason: 'INVALID', limit: 1 }],
    ['PROCESSING_FAILED', '200', { reason: 'PROCESSING_FAILED', limit: 200 }],
  ])('passes reason %s and limit %s on', async (reason, limit, expected) => {
    listQuarantine.mockResolvedValue([])

    const res = await get(`/quarantine?reason=${reason}&limit=${limit}`)

    expect(res.statusCode).toBe(200)
    expect(listQuarantine).toHaveBeenCalledExactlyOnceWith(expected)
  })

  it.each([
    ['limit=0', 'querystring.limit'],
    ['limit=201', 'querystring.limit'],
    ['limit=1.5', 'querystring.limit'],
    ['limit=abc', 'querystring.limit'],
    ['limit=', 'querystring.limit'],
    ['reason=CONFLICT', 'querystring.reason'],
    ['reason=invalid', 'querystring.reason'],
  ])('returns 400 VALIDATION_ERROR for %s and reads nothing', async (query, path) => {
    const res = await get(`/quarantine?${query}`)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: [{ path }] } })
    expect(listQuarantine).not.toHaveBeenCalled()
  })

  it('returns 503 DEPENDENCY_UNAVAILABLE when the database is unavailable', async () => {
    listQuarantine.mockRejectedValue(new DatabaseUnavailableError({ cause: new Error('timeout') }))

    const res = await get('/quarantine')

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ error: { code: 'DEPENDENCY_UNAVAILABLE' } })
  })
})

describe('OpenAPI document', () => {
  it('describes GET /quarantine with its parameters and status codes', async () => {
    const { parameters, responses } = (await get('/docs/json')).json().paths['/quarantine'].get

    expect(parameters.map((p: { name: string }) => p.name).sort()).toEqual(['limit', 'reason'])
    expect(Object.keys(responses)).toEqual(['200', '400', '500', '503'])
  })

  it('describes the read endpoints with all their status codes', async () => {
    const res = await get('/docs/json')

    expect(res.statusCode).toBe(200)
    for (const suffix of ['', '/history', '/anomalies']) {
      const { parameters, responses } = res.json().paths[`/tracking/{shipmentId}${suffix}`].get
      expect(parameters).toMatchObject([{ in: 'path', name: 'shipmentId', schema: { format: 'uuid' } }])
      expect(Object.keys(responses)).toEqual(['200', '400', '404', '500', '503'])
    }
  })
})

describe('health routes', () => {
  it('GET /health/live returns 200', async () => {
    const res = await get('/health/live')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('GET /health/ready returns 200 when the database and NATS are up', async () => {
    const res = await get('/health/ready')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', nats: 'ok' } })
  })

  it('GET /health/ready returns 503 when the database is down', async () => {
    checks.database.mockRejectedValue(new Error('down'))

    const res = await get('/health/ready')

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'not_ready', checks: { database: 'failed', nats: 'ok' } })
  })

  it('GET /health/ready returns 200 and reports NATS when only NATS is down (ADR-0012)', async () => {
    checks.nats.mockRejectedValue(new Error('down'))

    const res = await get('/health/ready')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', nats: 'failed' } })
  })
})
