import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import type { GetShipment } from '../application/get-shipment.js'
import type { RegisterShipment } from '../application/register-shipment.js'
import { toIsoUtc, type Shipment } from '../domain/shipment.js'
import type { CheckReadiness } from '../health.js'
import { errorBody, handleError, NotFoundError } from './errors.js'
import {
  ErrorBodySchema,
  LiveResponseSchema,
  ReadyResponseSchema,
  RegisterShipmentBodySchema,
  ShipmentParamsSchema,
  ShipmentResponseSchema,
  type ShipmentResponse,
} from './schemas.js'

export type AppDeps = {
  registerShipment: RegisterShipment
  getShipment: GetShipment
  checkReadiness: CheckReadiness
  /** A ready logger (main.ts) or Fastify logger options; tests pass false. */
  logger?: FastifyBaseLogger | FastifyServerOptions['logger']
}

function toResponse(shipment: Shipment): ShipmentResponse {
  return {
    shipmentId: shipment.shipmentId,
    trackingNumber: shipment.trackingNumber,
    orderReference: shipment.orderReference,
    originFacilityId: shipment.originFacilityId,
    destination: shipment.destination,
    recipientId: shipment.recipientId,
    expectedDeliveryAt: toIsoUtc(shipment.expectedDeliveryAt),
  }
}

function isLoggerInstance(logger: AppDeps['logger']): logger is FastifyBaseLogger {
  return typeof logger === 'object' && logger !== null && typeof (logger as FastifyBaseLogger).child === 'function'
}

/** Builds the HTTP app without listening, so tests can use app.inject. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger = deps.logger ?? true
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
        title: 'Shipment Service',
        description: 'Registers shipments and publishes shipment.registered (docs/shipment-api.md).',
        version: '1.0.0',
      },
    },
    transform: jsonSchemaTransform,
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  const errorResponses = {
    400: ErrorBodySchema,
    404: ErrorBodySchema,
    409: ErrorBodySchema,
    500: ErrorBodySchema,
    503: ErrorBodySchema,
  }

  app.post(
    '/shipments',
    {
      schema: {
        summary: 'Register a shipment',
        body: RegisterShipmentBodySchema,
        response: { 201: ShipmentResponseSchema, 200: ShipmentResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const body = request.body
      const { status, shipment } = await deps.registerShipment({
        ...body,
        expectedDeliveryAt: new Date(body.expectedDeliveryAt),
      })
      request.log.info(
        {
          shipmentId: shipment.shipmentId,
          correlationId: shipment.shipmentId,
          eventId: shipment.registeredEventId,
          result: status,
        },
        status === 'created' ? 'shipment registered' : 'shipment registration repeated',
      )
      return reply.status(status === 'created' ? 201 : 200).send(toResponse(shipment))
    },
  )

  app.get(
    '/shipments/:shipmentId',
    {
      schema: {
        summary: 'Get a shipment',
        params: ShipmentParamsSchema,
        response: { 200: ShipmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const shipment = await deps.getShipment(request.params.shipmentId)
      if (!shipment) throw new NotFoundError(`Shipment ${request.params.shipmentId} not found.`)
      return toResponse(shipment)
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
        summary: 'The database and NATS are reachable',
        response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema },
      },
    },
    async (_request, reply) => {
      const result = await deps.checkReadiness()
      const ready = result.database && result.nats
      return reply.status(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not_ready',
        checks: {
          database: result.database ? 'ok' : 'failed',
          nats: result.nats ? 'ok' : 'failed',
        },
      })
    },
  )

  return app
}
