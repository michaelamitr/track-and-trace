import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createHttpApp, type HttpApp, type HttpAppOptions } from './app.js'

let app: HttpApp

afterEach(async () => {
  await app?.close()
})

async function create(options: Partial<HttpAppOptions> = {}) {
  app = await createHttpApp({ title: 'Some Service', description: 'Does something.', logger: false, ...options })
  return app
}

describe('createHttpApp', () => {
  it('validates requests and serializes responses with the Zod schemas of a route', async () => {
    const app = await create()
    app.get(
      '/items/:id',
      { schema: { params: z.object({ id: z.coerce.number() }), response: { 200: z.object({ id: z.number() }) } } },
      async (request) => ({ id: request.params.id, secret: 'not in the schema' }),
    )

    const valid = await app.inject({ method: 'GET', url: '/items/7' })
    const invalid = await app.inject({ method: 'GET', url: '/items/x' })

    expect(valid.statusCode).toBe(200)
    expect(valid.json()).toEqual({ id: 7 })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('returns the error body with 404 for an unknown route', async () => {
    const app = await create()

    const res = await app.inject({ method: 'GET', url: '/nope?x=1' })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route GET /nope?x=1 not found.' } })
  })

  it('serves the OpenAPI document with the title and description, and Swagger UI', async () => {
    const app = await create()
    app.get('/items', { schema: { summary: 'List items' } }, async () => [])

    const json = await app.inject({ method: 'GET', url: '/docs/json' })
    const ui = await app.inject({ method: 'GET', url: '/docs/' })

    expect(json.json().info).toEqual({ title: 'Some Service', description: 'Does something.', version: '1.0.0' })
    expect(json.json().paths['/items'].get.summary).toBe('List items')
    expect(ui.statusCode).toBe(200)
    expect(ui.headers['content-type']).toContain('text/html')
  })

  it('logs to a ready pino instance, keeping its fields', async () => {
    const lines: Record<string, unknown>[] = []
    const logger = pino({ base: { service: 'some' } }, { write: (line: string) => lines.push(JSON.parse(line)) })
    const app = await create({ logger })
    app.get('/log', async (request) => {
      request.log.info('hello')
      return {}
    })

    await app.inject({ method: 'GET', url: '/log' })

    expect(lines).toContainEqual(expect.objectContaining({ msg: 'hello', service: 'some' }))
  })

  it('creates a logger from logger options', async () => {
    const lines: Record<string, unknown>[] = []
    const app = await create({
      logger: { level: 'warn', stream: { write: (line: string) => void lines.push(JSON.parse(line)) } },
    })
    app.log.info('too quiet')
    app.log.warn('loud enough')

    expect(lines.map((line) => line.msg)).toEqual(['loud enough'])
  })
})
