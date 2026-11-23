import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'

const checks = { database: vi.fn(), nats: vi.fn() }
let app: FastifyInstance

beforeEach(async () => {
  vi.resetAllMocks()
  checks.database.mockResolvedValue(undefined)
  checks.nats.mockResolvedValue(undefined)
  app = await buildApp({ checks, logger: false })
})

afterEach(async () => {
  await app.close()
})

describe('health routes', () => {
  it('GET /health/live returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('GET /health/ready returns 200 when the database and NATS are up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', nats: 'ok' } })
  })

  it('GET /health/ready returns 503 when the database is down', async () => {
    checks.database.mockRejectedValue(new Error('down'))

    const res = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'not_ready', checks: { database: 'failed', nats: 'ok' } })
  })

  it('GET /health/ready returns 200 and reports NATS when only NATS is down (ADR-0012)', async () => {
    checks.nats.mockRejectedValue(new Error('down'))

    const res = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', nats: 'failed' } })
  })
})
