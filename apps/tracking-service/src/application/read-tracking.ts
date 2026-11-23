import { translateDatabaseError } from '@tt/db'
import type pg from 'pg'
import { findAnomalies, findHistory, findTracking } from '../db/tracking-queries.js'
import type { TrackingAnomalies, TrackingHistory, TrackingState } from '../domain/tracking-view.js'

/** Reads the stored read model of a shipment; null if the shipment is not known. */
export type ReadTracking<T> = (shipmentId: string) => Promise<T | null>

export type GetTracking = ReadTracking<TrackingState>
export type GetHistory = ReadTracking<TrackingHistory>
export type GetAnomalies = ReadTracking<TrackingAnomalies>

function createRead<T>(pool: pg.Pool, find: (db: pg.Pool, shipmentId: string) => Promise<T | null>): ReadTracking<T> {
  return async function read(shipmentId) {
    try {
      return await find(pool, shipmentId)
    } catch (err) {
      throw translateDatabaseError(err)
    }
  }
}

export function createGetTracking(deps: { pool: pg.Pool }): GetTracking {
  return createRead(deps.pool, findTracking)
}

export function createGetHistory(deps: { pool: pg.Pool }): GetHistory {
  return createRead(deps.pool, findHistory)
}

export function createGetAnomalies(deps: { pool: pg.Pool }): GetAnomalies {
  return createRead(deps.pool, findAnomalies)
}
