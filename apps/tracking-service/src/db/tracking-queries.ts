import type pg from 'pg'
import type {
  StoredConflict,
  StoredHistoryEntry,
  TrackingAnomalies,
  TrackingHistory,
  TrackingState,
} from '../domain/tracking-view.js'

// The read side. Every query is ONE statement, so it sees one snapshot and never
// mixes rows from before and after a concurrent re-projection. It selects from
// shipment_tracking: no row means that the shipment is not known.

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

// Lists are read as JSON. Times are epoch milliseconds there: unlike a formatted
// time they do not depend on the time zone of the session.
type Json<T> = { [K in keyof T]: T[K] extends Date ? number : T[K] }

const HISTORY_ENTRY = `json_build_object(
  'eventId',    h.event_id,
  'eventType',  h.event_type,
  'status',     h.status,
  'occurredAt', extract(epoch FROM h.occurred_at) * 1000,
  'receivedAt', extract(epoch FROM h.received_at) * 1000,
  'facilityId', h.facility_id,
  'isAnomaly',  h.is_anomaly)`

const CONFLICT = `json_build_object(
  'eventId',         c.event_id,
  'streamSequence',  c.stream_sequence,
  'receivedAt',      extract(epoch FROM c.received_at) * 1000,
  'differingFields', c.differing_fields)`

function toHistoryEntry(entry: Json<StoredHistoryEntry>): StoredHistoryEntry {
  return { ...entry, occurredAt: new Date(entry.occurredAt), receivedAt: new Date(entry.receivedAt) }
}

function toConflict(conflict: Json<StoredConflict>): StoredConflict {
  return { ...conflict, receivedAt: new Date(conflict.receivedAt) }
}

export async function findTracking(db: Queryable, shipmentId: string): Promise<TrackingState | null> {
  const result = await db.query<TrackingState>(
    `SELECT shipment_id     AS "shipmentId",
            tracking_number AS "trackingNumber",
            status,
            last_location   AS "lastLocation",
            last_event_at   AS "lastEventAt",
            delivered_at    AS "deliveredAt",
            updated_at      AS "updatedAt"
       FROM shipment_tracking WHERE shipment_id = $1`,
    [shipmentId],
  )
  return result.rows[0] ?? null
}

export async function findHistory(db: Queryable, shipmentId: string): Promise<TrackingHistory | null> {
  const result = await db.query<{ shipment_id: string; events: Json<StoredHistoryEntry>[] }>(
    `SELECT s.shipment_id,
            (SELECT coalesce(json_agg(${HISTORY_ENTRY} ORDER BY h.position), '[]')
               FROM tracking_history h
              WHERE h.shipment_id = s.shipment_id) AS events
       FROM shipment_tracking s WHERE s.shipment_id = $1`,
    [shipmentId],
  )
  const row = result.rows[0]
  return row ? { shipmentId: row.shipment_id, events: row.events.map(toHistoryEntry) } : null
}

export async function findAnomalies(db: Queryable, shipmentId: string): Promise<TrackingAnomalies | null> {
  const result = await db.query<{
    shipment_id: string
    after_delivery: Json<StoredHistoryEntry>[]
    conflicts: Json<StoredConflict>[]
  }>(
    `SELECT s.shipment_id,
            (SELECT coalesce(json_agg(${HISTORY_ENTRY} ORDER BY h.position), '[]')
               FROM tracking_history h
              WHERE h.shipment_id = s.shipment_id AND h.is_anomaly) AS after_delivery,
            (SELECT coalesce(json_agg(${CONFLICT} ORDER BY c.stream_sequence), '[]')
               FROM tracking_conflicts c
              WHERE c.shipment_id = s.shipment_id) AS conflicts
       FROM shipment_tracking s WHERE s.shipment_id = $1`,
    [shipmentId],
  )
  const row = result.rows[0]
  return row
    ? {
        shipmentId: row.shipment_id,
        afterDelivery: row.after_delivery.map(toHistoryEntry),
        conflicts: row.conflicts.map(toConflict),
      }
    : null
}
