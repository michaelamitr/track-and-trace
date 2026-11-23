import type { FastifyRequest } from 'fastify'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createHttpApp, type HttpApp } from './app.js'
import { errorBody, errorBodySchema, SHARED_ERROR_CODES, type ErrorBody } from './error-body.js'
import { NotFoundError, type ErrorResponse, type MapServiceError } from './error-handler.js'

class TeapotError extends Error {}

let app: HttpApp
let logLines: Record<string, unknown>[]
const failWith = vi.fn<() => unknown>()
const mapServiceError = vi.fn<MapServiceError<'TEAPOT'>>()

beforeEach(async () => {
  failWith.mockReset()
  mapServiceError.mockReset().mockImplementation((error): ErrorResponse<'TEAPOT'> | undefined =>
    error instanceof TeapotError ? { status: 418, body: errorBody('TEAPOT', 'Short and stout.') } : undefined,
  )
  logLines = []
  app = await createHttpApp({
    title: 'Some Service',
    description: 'Does something.',
    mapServiceError,
    logger: pino({ level: 'info' }, { write: (line: string) => logLines.push(JSON.parse(line)) }),
  })
  app.post(
    '/items',
    { schema: { body: z.object({ name: z.string().min(1), nested: z.object({ n: z.number() }).optional() }) } },
    async () => {
      throw failWith()
    },
  )
})

afterEach(async () => {
  await app.close()
})

function post(payload: object = { name: 'x' }) {
  return app.inject({ method: 'POST', url: '/items', payload })
}

const errorLogs = () => logLines.filter((line) => line.level === 50).map((line) => line.msg)

describe('error handler: generic cases', () => {
  it('maps a failed Zod validation to 400 with the failing fields', async () => {
    const res = await post({ name: '', nested: { n: 'x' } })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request is invalid.',
        details: [
          { path: 'body.name', message: expect.any(String) },
          { path: 'body.nested.n', message: expect.any(String) },
        ],
      },
    })
    expect(mapServiceError).not.toHaveBeenCalled()
  })

  it('maps malformed JSON to 400 VALIDATION_ERROR without details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    expect(res.json().error.details).toBeUndefined()
  })

  it("keeps the status of Fastify's other 4xx errors as BAD_REQUEST", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/items',
      headers: { 'content-type': 'application/xml' },
      payload: '<x/>',
    })

    expect(res.statusCode).toBe(415)
    expect(res.json().error.code).toBe('BAD_REQUEST')
    expect(errorLogs()).toEqual([])
  })

  it('maps NotFoundError to 404 with its message', async () => {
    failWith.mockReturnValue(new NotFoundError('Item x not found.'))

    const res = await post()

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Item x not found.' } })
    expect(errorLogs()).toEqual([])
  })

  it.each([
    ['an unknown error', new Error('secret-host is down')],
    ['an error with a 5xx status', Object.assign(new Error('secret-host is down'), { statusCode: 502 })],
  ])('logs %s and returns 500 without its details', async (_label, error) => {
    failWith.mockReturnValue(error)

    const res = await post()

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } })
    expect(errorLogs()).toEqual(['unhandled error'])
  })
})

describe('error handler: own errors of a service', () => {
  it('uses the status and body from the hook and does not log by itself', async () => {
    failWith.mockReturnValue(new TeapotError())

    const res = await post()

    expect(res.statusCode).toBe(418)
    expect(res.json()).toEqual({ error: { code: 'TEAPOT', message: 'Short and stout.' } })
    expect(errorLogs()).toEqual([])
  })

  it('passes the request to the hook, so the service can log with it', async () => {
    const error = new TeapotError()
    failWith.mockReturnValue(error)

    await post()

    const [passed, request] = mapServiceError.mock.calls[0] as [unknown, FastifyRequest]
    expect(passed).toBe(error)
    expect(request.url).toBe('/items')
  })
})

describe('errorBodySchema', () => {
  it('accepts the shared codes and rejects any other', () => {
    const schema = errorBodySchema()
    for (const code of SHARED_ERROR_CODES) expect(schema.safeParse(errorBody(code, 'm')).success).toBe(true)

    const result = schema.safeParse({ error: { code: 'TEAPOT', message: 'm' } })
    expect(result.error?.issues[0]?.path).toEqual(['error', 'code'])
  })

  it("accepts the service's own codes next to the shared ones", () => {
    const schema = errorBodySchema(['TEAPOT'])

    expect(schema.safeParse(errorBody<'TEAPOT'>('TEAPOT', 'm')).success).toBe(true)
    expect(schema.safeParse(errorBody('NOT_FOUND', 'm')).success).toBe(true)
  })
})

describe('errorBody', () => {
  it('has details only when they are given', () => {
    expect(errorBody('NOT_FOUND', 'm')).toEqual({ error: { code: 'NOT_FOUND', message: 'm' } })
    expect(errorBody('VALIDATION_ERROR', 'm', [{ path: 'body.a', message: 'bad' }])).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'm', details: [{ path: 'body.a', message: 'bad' }] },
    })
  })

  it('rejects unknown codes at compile time (pnpm typecheck)', () => {
    // @ts-expect-error TEAPOT is not a shared code.
    errorBody('TEAPOT', 'm')
    // @ts-expect-error TYPO is not one of the service's codes.
    const body: ErrorBody<'TEAPOT'> = errorBody<'TEAPOT'>('TYPO', 'm')
    expect(body.error.code).toBe('TYPO')
  })
})
