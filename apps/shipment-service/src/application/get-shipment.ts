import { translateDatabaseError } from '@tt/db'
import type pg from 'pg'
import { findShipmentById } from '../db/shipments.js'
import type { Shipment } from '../domain/shipment.js'

export type GetShipment = (shipmentId: string) => Promise<Shipment | null>

export function createGetShipment(deps: { pool: pg.Pool }): GetShipment {
  return async function getShipment(shipmentId) {
    try {
      return await findShipmentById(deps.pool, shipmentId)
    } catch (err) {
      throw translateDatabaseError(err)
    }
  }
}
