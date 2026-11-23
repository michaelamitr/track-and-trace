import { createHttpApp, NotFoundError, registerHealthRoutes, type LoggerOption } from '@tt/http'
import type { FastifyInstance } from 'fastify'
import type { GetAnomalies, GetHistory, GetTracking } from '../application/read-tracking.js'
import type { StoredHistoryEntry, TrackingState } from '../domain/tracking-view.js'
import type { TrackingHealthChecks } from '../health.js'
import { mapServiceError } from './errors.js'
import {
  AnomaliesResponseSchema,
  ErrorBodySchema,
  HistoryResponseSchema,
  ShipmentParamsSchema,
  TrackingResponseSchema,
  type HistoryEntryResponse,
  type TrackingResponse,
} from './schemas.js'

export type AppDeps = {
  getTracking: GetTracking
  getHistory: GetHistory
  getAnomalies: GetAnomalies
  checks: TrackingHealthChecks
  /** A ready logger (main.ts) or Fastify logger options; tests pass false. */
  logger?: LoggerOption
}

function toTrackingResponse(state: TrackingState): TrackingResponse {
  return {
    ...state,
    lastEventAt: state.lastEventAt.toISOString(),
    deliveredAt: state.deliveredAt?.toISOString() ?? null,
    updatedAt: state.updatedAt.toISOString(),
  }
}

function toEntryResponse(entry: StoredHistoryEntry): HistoryEntryResponse {
  return { ...entry, occurredAt: entry.occurredAt.toISOString(), receivedAt: entry.receivedAt.toISOString() }
}

/** The shipment is not known until its shipment.registered has been processed. */
function notFound(shipmentId: string): NotFoundError {
  return new NotFoundError(`Shipment ${shipmentId} not found.`)
}

/** Builds the HTTP app without listening, so tests can use app.inject. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = await createHttpApp({
    title: 'Tracking Service',
    description: 'Status, history and anomalies of shipments (docs/tracking-api.md).',
    mapServiceError,
    logger: deps.logger,
  })

  const errorResponses = {
    400: ErrorBodySchema,
    404: ErrorBodySchema,
    500: ErrorBodySchema,
    503: ErrorBodySchema,
  }

  app.get(
    '/tracking/:shipmentId',
    {
      schema: {
        summary: 'Get the current state of a shipment',
        params: ShipmentParamsSchema,
        response: { 200: TrackingResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { shipmentId } = request.params
      const state = await deps.getTracking(shipmentId)
      if (!state) throw notFound(shipmentId)
      return toTrackingResponse(state)
    },
  )

  app.get(
    '/tracking/:shipmentId/history',
    {
      schema: {
        summary: 'Get the ordered history of a shipment',
        params: ShipmentParamsSchema,
        response: { 200: HistoryResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { shipmentId } = request.params
      const history = await deps.getHistory(shipmentId)
      if (!history) throw notFound(shipmentId)
      return { shipmentId: history.shipmentId, events: history.events.map(toEntryResponse) }
    },
  )

  app.get(
    '/tracking/:shipmentId/anomalies',
    {
      schema: {
        summary: 'Get the anomalies after delivery and the conflicting copies of a shipment',
        params: ShipmentParamsSchema,
        response: { 200: AnomaliesResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { shipmentId } = request.params
      const anomalies = await deps.getAnomalies(shipmentId)
      if (!anomalies) throw notFound(shipmentId)
      return {
        shipmentId: anomalies.shipmentId,
        afterDelivery: anomalies.afterDelivery.map(toEntryResponse),
        conflicts: anomalies.conflicts.map((conflict) => ({
          ...conflict,
          receivedAt: conflict.receivedAt.toISOString(),
        })),
      }
    },
  )

  // ADR-0012: requests need only the database; without NATS the data only grows stale.
  registerHealthRoutes(app, {
    required: { database: deps.checks.database },
    informational: { nats: deps.checks.nats },
    readySummary: 'The database is reachable; NATS is reported only',
  })

  return app
}
