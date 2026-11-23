import type pg from 'pg'
import type { EventCopy } from '../domain/event-copy.js'
import type { TrackingEvent } from '../domain/shipment-status.js'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

export type KeptCopy = EventCopy & { shipmentId: string }

// Times are stored as Date (milliseconds): the precision in which project() and
// differingFields() compare them, so the columns always agree with the payload.
function columnValues({ event, subject, streamSequence }: EventCopy): unknown[] {
  return [
    event.eventId,
    event.shipmentId,
    event.eventType,
    new Date(event.occurredAt),
    new Date(event.receivedAt),
    JSON.stringify(event),
    subject,
    streamSequence,
  ]
}

/** Stores the copy unless its event_id is already stored. Returns true if it was new. */
export async function insertEventIfNew(db: Queryable, copy: EventCopy): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO tracking_events
       (event_id, shipment_id, event_type, occurred_at, received_at, payload, subject, stream_sequence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (event_id) DO NOTHING`,
    columnValues(copy),
  )
  return result.rowCount === 1
}

/** The kept copy of an event. */
export async function findKeptCopy(db: Queryable, eventId: string): Promise<KeptCopy | null> {
  const result = await db.query<{
    shipment_id: string
    payload: TrackingEvent
    subject: string
    stream_sequence: string
  }>(`SELECT shipment_id, payload, subject, stream_sequence FROM tracking_events WHERE event_id = $1`, [eventId])
  const row = result.rows[0]
  if (!row) return null
  return {
    shipmentId: row.shipment_id,
    event: row.payload,
    subject: row.subject,
    // bigint is read as a string.
    streamSequence: Number(row.stream_sequence),
  }
}

/** Replaces the kept copy of an event as a whole. */
export async function replaceKeptCopy(db: Queryable, copy: EventCopy): Promise<void> {
  await db.query(
    `UPDATE tracking_events SET
       shipment_id = $2, event_type = $3, occurred_at = $4, received_at = $5,
       payload = $6, subject = $7, stream_sequence = $8
     WHERE event_id = $1`,
    columnValues(copy),
  )
}

/** All events of a shipment, in no particular order: project() orders them (R2). */
export async function findEventsByShipment(db: Queryable, shipmentId: string): Promise<TrackingEvent[]> {
  const result = await db.query<{ payload: TrackingEvent }>(
    `SELECT payload FROM tracking_events WHERE shipment_id = $1`,
    [shipmentId],
  )
  return result.rows.map((row) => row.payload)
}
