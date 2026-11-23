import type { MessageMetadata } from '@tt/messaging'
import type pg from 'pg'
import type { StoredCopy } from '../domain/resolve-copies.js'
import type { TrackingEvent } from '../domain/shipment-status.js'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

/** Stores the message unless it is a redelivery. Returns true if it was new. */
export async function insertMessageIfNew(
  db: Queryable,
  event: TrackingEvent,
  { streamSequence, subject }: MessageMetadata,
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO received_messages
       (stream_sequence, event_id, shipment_id, subject, event_type, occurred_at, received_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (stream_sequence) DO NOTHING`,
    [
      streamSequence,
      event.eventId,
      event.shipmentId,
      subject,
      event.eventType,
      // As Date (milliseconds): the precision in which times are compared.
      new Date(event.occurredAt),
      new Date(event.receivedAt),
      JSON.stringify(event),
    ],
  )
  return result.rowCount === 1
}

/** The shipments of all copies of an event; more than one only for a conflict. */
export async function findShipmentsOfEvent(db: Queryable, eventId: string): Promise<string[]> {
  const result = await db.query<{ shipment_id: string }>(
    `SELECT DISTINCT shipment_id FROM received_messages WHERE event_id = $1 ORDER BY shipment_id`,
    [eventId],
  )
  return result.rows.map((row) => row.shipment_id)
}

/** All copies of the shipments and the copies of the same events that name other shipments. */
export async function findCopies(db: Queryable, shipmentIds: string[]): Promise<StoredCopy[]> {
  const result = await db.query<{
    stream_sequence: string
    event_id: string
    shipment_id: string
    payload: TrackingEvent
  }>(
    `SELECT stream_sequence, event_id, shipment_id, payload FROM received_messages
      WHERE event_id IN (SELECT event_id FROM received_messages WHERE shipment_id = ANY($1::uuid[]))`,
    [shipmentIds],
  )
  return result.rows.map((row) => ({
    // bigint is read as a string.
    streamSequence: Number(row.stream_sequence),
    eventId: row.event_id,
    shipmentId: row.shipment_id,
    event: row.payload,
  }))
}
