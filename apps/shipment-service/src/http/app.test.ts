import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderConflictError } from '../application/register-shipment.js'
import { DatabaseUnavailableError } from '../db/errors.js'
import type { Shipment } from '../domain/shipment.js'
import { buildApp } from './app.js'

const shipment: Shipment = {
  shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
  orderReference: 'ESHOP-2026-004211',
  trackingNumber: 'PF-4821093375',
  originFacilityId: 'PRG-HUB-01',
  destination: 'Brno',
  recipientId: 'cust-88231',
  expectedDeliveryAt: new Date('2026-11-11T16:00:00Z'),
  registeredAt: new Date('2026-11-10T09:15:30.123Z'),
  registeredEventId: '5b3f7d0e-2c1a-4e8b-9f6d-3a2b1c0d9e8f',
}

const body = {
  orderReference: 'ESHOP-2026-004211',
  originFacilityId: 'PRG-HUB-01',
  destination: 'Brno',
  recipientId: 'cust-88231',
  expectedDeliveryAt: '2026-11-11T16:00:00Z',
}

const response = { ...body, shipmentId: shipment.shipmentId, trackingNumber: shipment.trackingNumber }

const registerShipment = vi.fn()
const getShipment = vi.fn()
const checkReadiness = vi.fn()
let app: FastifyInstance

beforeEach(async () => {
  vi.resetAllMocks()
  app = await buildApp({ registerShipment, getShipment, checkReadiness, logger: false })
})

afterEach(async () => {
  await app.close()
})

function post(payload: unknown) {
  return app.inject({ method: 'POST', url: '/shipments', payload: payload as object })
}

describe('POST /shipments', () => {
  it('returns 201 for a created shipment and passes expectedDeliveryAt as a Date', async () => {
    registerShipment.mockResolvedValue({ status: 'created', shipment })

    const res = await post(body)

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual(response)
    expect(registerShipment).toHaveBeenCalledWith({ ...body, expectedDeliveryAt: new Date(body.expectedDeliveryAt) })
  })

  it('returns 200 for an existing shipment', async () => {
    registerShipment.mockResolvedValue({ status: 'existing', shipment })

    const res = await post(body)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(response)
  })

  it('returns 400 VALIDATION_ERROR with the failing fields and does not call the use case', async () => {
    const res = await post({ ...body, orderReference: '', expectedDeliveryAt: '2026-11-11T17:00:00+01:00' })

    expect(res.statusCode).toBe(400)
    const error = res.json().error
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'body.expectedDeliveryAt',
      'body.orderReference',
    ])
    expect(registerShipment).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR for malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/shipments',
      headers: { 'content-type': 'application/json' },
      payload: '{"orderReference":',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 409 ORDER_CONFLICT for OrderConflictError', async () => {
    registerShipment.mockRejectedValue(new OrderConflictError(body.orderReference))

    const res = await post(body)

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({
      error: { code: 'ORDER_CONFLICT', message: 'The orderReference is already registered with different data.' },
    })
  })

  it('returns 503 DEPENDENCY_UNAVAILABLE when the database is unavailable', async () => {
    registerShipment.mockRejectedValue(new DatabaseUnavailableError({ cause: new Error('ECONNREFUSED') }))

    const res = await post(body)

    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('DEPENDENCY_UNAVAILABLE')
  })

  it('returns 500 INTERNAL_ERROR without internal details for any other error', async () => {
    registerShipment.mockRejectedValue(new Error('relation "shipments" does not exist at secret-host'))

    const res = await post(body)

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } })
    expect(res.body).not.toContain('secret-host')
  })
})

describe('GET /shipments/:shipmentId', () => {
  it('returns the shipment', async () => {
    getShipment.mockResolvedValue(shipment)

    const res = await app.inject({ method: 'GET', url: `/shipments/${shipment.shipmentId}` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(response)
    expect(getShipment).toHaveBeenCalledWith(shipment.shipmentId)
  })

  it('returns 404 NOT_FOUND for an unknown shipment', async () => {
    getShipment.mockResolvedValue(null)

    const res = await app.inject({ method: 'GET', url: `/shipments/${shipment.shipmentId}` })

    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
  })

  it('returns 400 VALIDATION_ERROR for an id that is not a UUID', async () => {
    const res = await app.inject({ method: 'GET', url: '/shipments/not-a-uuid' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.details).toEqual([{ path: 'params.shipmentId', message: expect.any(String) }])
    expect(getShipment).not.toHaveBeenCalled()
  })

  it('returns 503 DEPENDENCY_UNAVAILABLE when the database is unavailable', async () => {
    getShipment.mockRejectedValue(new DatabaseUnavailableError({ cause: new Error('timeout') }))

    const res = await app.inject({ method: 'GET', url: `/shipments/${shipment.shipmentId}` })

    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('DEPENDENCY_UNAVAILABLE')
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

  it('GET /health/ready returns 200 when the database and NATS are up', async () => {
    checkReadiness.mockResolvedValue({ database: true, nats: true })

    const res = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', nats: 'ok' } })
  })

  it.each([
    [{ database: false, nats: true }, { database: 'failed', nats: 'ok' }],
    [{ database: true, nats: false }, { database: 'ok', nats: 'failed' }],
  ])('GET /health/ready returns 503 when a dependency is down (%o)', async (readiness, checks) => {
    checkReadiness.mockResolvedValue(readiness)

    const res = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'not_ready', checks })
  })

  it('serves the OpenAPI document with both shipment routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' })

    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.json().paths)).toEqual(
      expect.arrayContaining(['/shipments', '/shipments/{shipmentId}', '/health/live', '/health/ready']),
    )
  })
})
