import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { insertOutboxEvent } from '../db/outbox.js'
import {
  findShipmentByOrderReference,
  insertShipmentIfNew,
  TRACKING_NUMBER_CONSTRAINT,
} from '../db/shipments.js'
import { withTransaction } from '../db/transaction.js'
import {
  buildShipmentRegisteredEvent,
  matchesRequest,
  type Shipment,
  type ShipmentRequest,
} from '../domain/shipment.js'
import { generateTrackingNumber } from '../domain/tracking-number.js'

export type RegisterShipmentResult = { status: 'created' | 'existing'; shipment: Shipment }

export type RegisterShipment = (request: ShipmentRequest) => Promise<RegisterShipmentResult>

/** The orderReference is already registered with different data (ADR-0007). */
export class OrderConflictError extends Error {
  override name = 'OrderConflictError'
  constructor(readonly orderReference: string) {
    super(`orderReference ${orderReference} is already registered with different data`)
  }
}

/** Attempts in total when a generated tracking number is already taken. */
export const MAX_TRACKING_NUMBER_ATTEMPTS = 3

const UNIQUE_VIOLATION = '23505'

function isTrackingNumberCollision(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown }
  return e.code === UNIQUE_VIOLATION && e.constraint === TRACKING_NUMBER_CONSTRAINT
}

export function createRegisterShipment(deps: {
  pool: pg.Pool
  generateTrackingNumber?: () => string
  now?: () => Date
}): RegisterShipment {
  const nextTrackingNumber = deps.generateTrackingNumber ?? generateTrackingNumber
  const now = deps.now ?? (() => new Date())

  async function attempt(request: ShipmentRequest): Promise<RegisterShipmentResult> {
    return withTransaction(deps.pool, async (client) => {
      const inserted = await insertShipmentIfNew(client, {
        ...request,
        shipmentId: randomUUID(),
        trackingNumber: nextTrackingNumber(),
        registeredAt: now(),
        registeredEventId: randomUUID(),
      })

      if (inserted) {
        // Same transaction as the shipment: both are committed or neither (ADR-0009).
        await insertOutboxEvent(client, buildShipmentRegisteredEvent(inserted))
        return { status: 'created', shipment: inserted }
      }

      // The orderReference exists (possibly committed a moment ago by a concurrent request).
      const existing = await findShipmentByOrderReference(client, request.orderReference)
      if (!existing) {
        throw new Error(`Shipment ${request.orderReference} conflicted on insert but was not found`)
      }
      if (!matchesRequest(existing, request)) {
        throw new OrderConflictError(request.orderReference)
      }
      // A repeat: its outbox row already exists and guarantees publication.
      return { status: 'existing', shipment: existing }
    })
  }

  return async function registerShipment(request) {
    for (let attemptNo = 1; ; attemptNo++) {
      try {
        return await attempt(request)
      } catch (err) {
        if (isTrackingNumberCollision(err) && attemptNo < MAX_TRACKING_NUMBER_ATTEMPTS) continue
        throw err
      }
    }
  }
}
