import { afterEach, describe, expect, it } from 'vitest'
import { createHttpApp, type HttpApp } from './app.js'
import { registerHealthRoutes, type HealthRoutesOptions } from './health.js'

let app: HttpApp | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

const ok = async () => 'anything'
const failed = async () => {
  throw new Error('down')
}
const hangs = () => new Promise<never>(() => {})

async function get(url: string, options: Omit<HealthRoutesOptions, 'readySummary'>) {
  app = await createHttpApp({ title: 'Some Service', description: 'Does something.', logger: false })
  registerHealthRoutes(app, { ...options, readySummary: 'Everything it needs is up' })
  return app.inject({ method: 'GET', url })
}

describe('GET /health/live', () => {
  it('returns 200 whatever the checks say', async () => {
    const res = await get('/health/live', { required: { a: failed } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})

describe('GET /health/ready', () => {
  it('returns 200 when every check passes', async () => {
    const res = await get('/health/ready', { required: { a: ok, b: ok }, informational: { c: ok } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ready', checks: { a: 'ok', b: 'ok', c: 'ok' } })
  })

  it.each([
    ['first', { a: failed, b: ok }, { a: 'failed', b: 'ok', c: 'ok' }],
    ['second', { a: ok, b: failed }, { a: 'ok', b: 'failed', c: 'ok' }],
  ])('returns 503 when the %s required check fails', async (_label, required, checks) => {
    const res = await get('/health/ready', { required, informational: { c: ok } })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'not_ready', checks })
  })

  it('returns 200 and reports a failed informational check', async () => {
    const res = await get('/health/ready', { required: { a: ok }, informational: { c: failed } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ready', checks: { a: 'ok', c: 'failed' } })
  })

  it('needs no informational checks', async () => {
    const res = await get('/health/ready', { required: { a: ok } })

    expect(res.json()).toEqual({ status: 'ready', checks: { a: 'ok' } })
  })

  it('counts a check that does not finish in 2 seconds as failed; the checks run in parallel', async () => {
    const start = Date.now()
    const res = await get('/health/ready', { required: { a: hangs }, informational: { c: hangs } })
    const elapsed = Date.now() - start

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'not_ready', checks: { a: 'failed', c: 'failed' } })
    expect(elapsed).toBeGreaterThanOrEqual(1_900)
    expect(elapsed).toBeLessThan(3_500)
  })

  it('is documented with the given summary and the names of the checks', async () => {
    const res = await get('/docs/json', { required: { a: ok }, informational: { c: ok } })

    const operation = res.json().paths['/health/ready'].get
    expect(operation.summary).toBe('Everything it needs is up')
    for (const status of ['200', '503']) {
      const schema = operation.responses[status].content['application/json'].schema
      expect(Object.keys(schema.properties.checks.properties)).toEqual(['a', 'c'])
    }
  })
})

describe('registerHealthRoutes', () => {
  it('rejects a check that is both required and informational', async () => {
    await expect(get('/health/ready', { required: { a: failed }, informational: { a: ok } })).rejects.toThrow(
      'Health check "a" is both required and informational.',
    )
  })
})
