import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import type { IngestScan } from '../application/ingest-scan.js'
import type { CheckReadiness } from '../health.js'
import { errorBody, handleError } from './errors.js'
import {
  ErrorBodySchema,
  LiveResponseSchema,
  ReadyResponseSchema,
  ScanAcceptedResponseSchema,
  ScanBodySchema,
} from './schemas.js'

export type AppDeps = {
  ingestScan: IngestScan
  checkReadiness: CheckReadiness
  /** The clock for receivedAt and the occurredAt check; tests pass a fixed one. */
  now?: () => Date
  /** A ready logger (main.ts) or Fastify logger options; tests pass false. */
  logger?: FastifyBaseLogger | FastifyServerOptions['logger']
}

function isLoggerInstance(logger: AppDeps['logger']): logger is FastifyBaseLogger {
  return typeof logger === 'object' && logger !== null && typeof (logger as FastifyBaseLogger).child === 'function'
}

/** Builds the HTTP app without listening, so tests can use app.inject. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger = deps.logger ?? true
  const now = deps.now ?? (() => new Date())
  const app = Fastify(isLoggerInstance(logger) ? { loggerInstance: logger } : { logger })
    .withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.setErrorHandler(handleError)
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(errorBody('NOT_FOUND', `Route ${request.method} ${request.url} not found.`)),
  )

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Scan Ingestion Service',
        description: 'Accepts scans and publishes parcel.* events (docs/scan-ingestion-api.md).',
        version: '1.0.0',
      },
    },
    transform: jsonSchemaTransform,
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

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

  app.get(
    '/health/live',
    { schema: { summary: 'The process is up', response: { 200: LiveResponseSchema } } },
    async () => ({ status: 'ok' as const }),
  )

  app.get(
    '/health/ready',
    {
      schema: {
        summary: 'NATS is connected',
        response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema },
      },
    },
    async (_request, reply) => {
      const result = await deps.checkReadiness()
      return reply.status(result.nats ? 200 : 503).send({
        status: result.nats ? 'ready' : 'not_ready',
        checks: { nats: result.nats ? 'ok' : 'failed' },
      })
    },
  )

  return app
}
