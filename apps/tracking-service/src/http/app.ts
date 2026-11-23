import { createHttpApp, registerHealthRoutes, type LoggerOption } from '@tt/http'
import type { FastifyInstance } from 'fastify'
import type { TrackingHealthChecks } from '../health.js'

export type AppDeps = {
  checks: TrackingHealthChecks
  /** A ready logger (main.ts) or Fastify logger options; tests pass false. */
  logger?: LoggerOption
}

/** Builds the HTTP app without listening, so tests can use app.inject. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = await createHttpApp({
    title: 'Tracking Service',
    description: 'Status and history of shipments (docs/tracking-api.md). The read endpoints are planned.',
    logger: deps.logger,
  })

  // ADR-0012: requests need only the database; without NATS the data only grows stale.
  registerHealthRoutes(app, {
    required: { database: deps.checks.database },
    informational: { nats: deps.checks.nats },
    readySummary: 'The database is reachable; NATS is reported only',
  })

  return app
}
