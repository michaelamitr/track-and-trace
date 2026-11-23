import type pg from 'pg'
import type { HistoryEntry, TrackingProjection } from '../domain/projection.js'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

function toDate(time: string | null): Date | null {
  return time === null ? null : new Date(time)
}

/** Creates or updates the current state of a known shipment. updated_at is the processing time. */
export async function upsertShipmentTracking(
  db: Queryable,
  shipmentId: string,
  trackingNumber: string,
  projection: TrackingProjection,
): Promise<void> {
  await db.query(
    `INSERT INTO shipment_tracking
       (shipment_id, tracking_number, status, last_location, last_event_at, delivered_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (shipment_id) DO UPDATE SET
       tracking_number = EXCLUDED.tracking_number,
       status          = EXCLUDED.status,
       last_location   = EXCLUDED.last_location,
       last_event_at   = EXCLUDED.last_event_at,
       delivered_at    = EXCLUDED.delivered_at,
       updated_at      = EXCLUDED.updated_at`,
    [
      shipmentId,
      trackingNumber,
      projection.status,
      projection.lastLocation,
      toDate(projection.lastEventAt),
      toDate(projection.deliveredAt),
    ],
  )
}

/** Removes a shipment that is not known from the read model; usually there is nothing to remove. */
export async function deleteReadModel(db: Queryable, shipmentId: string): Promise<void> {
  await db.query(`DELETE FROM tracking_history WHERE shipment_id = $1`, [shipmentId])
  await db.query(`DELETE FROM shipment_tracking WHERE shipment_id = $1`, [shipmentId])
}

/** Replaces the whole history of a shipment; positions follow the given (R2) order from 1. */
export async function replaceHistory(db: Queryable, shipmentId: string, history: HistoryEntry[]): Promise<void> {
  await db.query(`DELETE FROM tracking_history WHERE shipment_id = $1`, [shipmentId])
  await db.query(
    `INSERT INTO tracking_history
       (shipment_id, position, event_id, event_type, status, occurred_at, received_at, facility_id, is_anomaly)
     SELECT $1, entry.*
       FROM unnest($2::integer[], $3::uuid[], $4::text[], $5::text[], $6::timestamptz[], $7::timestamptz[],
                   $8::text[], $9::boolean[]) AS entry`,
    [
      shipmentId,
      history.map((_entry, index) => index + 1),
      history.map((entry) => entry.eventId),
      history.map((entry) => entry.eventType),
      history.map((entry) => entry.status),
      history.map((entry) => new Date(entry.occurredAt)),
      history.map((entry) => new Date(entry.receivedAt)),
      history.map((entry) => entry.facilityId),
      history.map((entry) => entry.isAnomaly),
    ],
  )
}
