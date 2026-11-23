import { z } from 'zod'
import type { HttpApp } from './app.js'

/** Passes if it resolves within CHECK_TIMEOUT_MS; fails if it rejects or takes longer. */
export type HealthCheck = () => Promise<unknown>

/** Checks by the name they have in the response, e.g. { database: ... }. */
export type HealthChecks = Record<string, HealthCheck>

export type HealthRoutesOptions = {
  /** Dependencies on the request path: one failed check means 503. */
  required: HealthChecks
  /** Reported in `checks` only; they never change the status (ADR-0012). */
  informational?: HealthChecks
  /** Summary of /health/ready in the OpenAPI document. */
  readySummary: string
}

const CHECK_TIMEOUT_MS = 2_000

const LiveResponseSchema = z.object({ status: z.literal('ok') })

const CheckSchema = z.enum(['ok', 'failed'])

function readyResponseSchema(names: string[]) {
  return z.object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.object(Object.fromEntries(names.map((name) => [name, CheckSchema]))),
  })
}

/** Resolves true if `check` succeeds within CHECK_TIMEOUT_MS, otherwise false. */
async function passes(check: HealthCheck): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS)
  })
  try {
    return await Promise.race([check().then(() => true, () => false), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Adds GET /health/live and GET /health/ready (ADR-0012). "Ready" means the
 * service can answer its HTTP requests: 200 only if every required check
 * passes. All checks run in parallel and every one is listed in `checks`.
 */
export function registerHealthRoutes(app: HttpApp, options: HealthRoutesOptions): void {
  const required = Object.keys(options.required)
  const informational = Object.keys(options.informational ?? {})
  const duplicate = required.find((name) => informational.includes(name))
  if (duplicate) throw new Error(`Health check "${duplicate}" is both required and informational.`)

  const checks = Object.entries({ ...options.required, ...options.informational })
  const ReadyResponseSchema = readyResponseSchema([...required, ...informational])

  app.get(
    '/health/live',
    { schema: { summary: 'The process is up', response: { 200: LiveResponseSchema } } },
    async () => ({ status: 'ok' as const }),
  )

  app.get(
    '/health/ready',
    {
      schema: {
        summary: options.readySummary,
        response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema },
      },
    },
    async (_request, reply) => {
      const results = new Map(
        await Promise.all(checks.map(async ([name, check]) => [name, await passes(check)] as const)),
      )
      const ready = required.every((name) => results.get(name))
      return reply.status(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not_ready',
        checks: Object.fromEntries([...results].map(([name, ok]) => [name, ok ? 'ok' : 'failed'])),
      })
    },
  )
}
