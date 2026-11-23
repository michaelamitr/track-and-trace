import { createHttpApp, registerHealthRoutes, type LoggerOption } from '@tt/http'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { IngestScan } from '../application/ingest-scan.js'
import type { ScanIngestionHealthChecks } from '../health.js'
import { mapServiceError } from './errors.js'
import {
  ErrorBodySchema,
  ScanAcceptedResponseSchema,
  ScanBodySchema,
} from './schemas.js'

export type AppDeps = {
  ingestScan: IngestScan
  checks: ScanIngestionHealthChecks
  /** The clock for receivedAt and the occurredAt check; tests pass a fixed one. */
  now?: () => Date
  /** A ready logger (main.ts) or Fastify logger options; tests pass false. */
  logger?: LoggerOption
}

/** Builds the HTTP app without listening, so tests can use app.inject. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date())
  const app = await createHttpApp({
    title: 'Scan Ingestion Service',
    description: 'Accepts scans and publishes parcel.* events (docs/scan-ingestion-api.md).',
    mapServiceError,
    logger: deps.logger,
  })

  const errorResponses = { 400: ErrorBodySchema, 500: ErrorBodySchema, 503: ErrorBodySchema }

  // receivedAt = when the request arrived, before the body is read and validated.
  const receivedAt = new WeakMap<FastifyRequest, Date>()

  app.post(
    '/scans',
    {
      schema: {
        summary: 'Accept a scan',
        body: ScanBodySchema,
        response: { 202: ScanAcceptedResponseSchema, ...errorResponses },
      },
      onRequest: async (request) => {
        receivedAt.set(request, now())
      },
    },
    async (request, reply) => {
      const event = await deps.ingestScan(request.body, receivedAt.get(request) ?? now())
      request.log.info(
        {
          eventId: event.eventId,
          eventType: event.eventType,
          shipmentId: event.shipmentId,
          correlationId: event.correlationId,
          result: 'accepted',
        },
        'scan accepted',
      )
      return reply.status(202).send({ eventId: event.eventId })
    },
  )

  // ADR-0012: every scan is published inside its request, so NATS is required.
  registerHealthRoutes(app, {
    required: { nats: deps.checks.nats },
    readySummary: 'NATS is connected',
  })

  return app
}
