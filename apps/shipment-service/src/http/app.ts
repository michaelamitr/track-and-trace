import { createHttpApp, NotFoundError, registerHealthRoutes, type LoggerOption } from '@tt/http'
import type { FastifyInstance } from 'fastify'
import type { GetShipment } from '../application/get-shipment.js'
import type { RegisterShipment } from '../application/register-shipment.js'
import { toIsoUtc, type Shipment } from '../domain/shipment.js'
import type { ShipmentHealthChecks } from '../health.js'
import { mapServiceError } from './errors.js'
import {
  ErrorBodySchema,
  RegisterShipmentBodySchema,
  ShipmentParamsSchema,
  ShipmentResponseSchema,
  type ShipmentResponse,
} from './schemas.js'

export type AppDeps = {
  registerShipment: RegisterShipment
  getShipment: GetShipment
  checks: ShipmentHealthChecks
  /** A ready logger (main.ts) or Fastify logger options; tests pass false. */
  logger?: LoggerOption
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

/** Builds the HTTP app without listening, so tests can use app.inject. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = await createHttpApp({
    title: 'Shipment Service',
    description: 'Registers shipments and publishes shipment.registered (docs/shipment-api.md).',
    mapServiceError,
    logger: deps.logger,
  })

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

  // ADR-0012: requests need only the database; events wait in the outbox while NATS is down.
  registerHealthRoutes(app, {
    required: { database: deps.checks.database },
    informational: { nats: deps.checks.nats },
    readySummary: 'The database is reachable; NATS is reported only',
  })

  return app
}
