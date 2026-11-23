import type pg from 'pg'
import type { EventCopy } from '../domain/event-copy.js'
import type { TrackingEvent } from '../domain/shipment-status.js'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

export type Conflict = {
  copy: EventCopy
  /** Shipment of the kept copy; the conflicting copy has its own in the payload. */
  shipmentId: string
  differingFields: string[]
}

/** Quarantines a conflicting copy. A redelivery has the same stream sequence, so it adds no row. */
export async function quarantineConflict(db: Queryable, conflict: Conflict): Promise<void> {
  const { event, subject, streamSequence } = conflict.copy
  await db.query(
    `INSERT INTO quarantined_events (reason, event_id, shipment_id, subject, stream_sequence, payload, details)
     VALUES ('CONFLICT', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (stream_sequence) DO NOTHING`,
    [
      event.eventId,
      conflict.shipmentId,
      subject,
      streamSequence,
      JSON.stringify(event),
      JSON.stringify(conflict.differingFields),
    ],
  )
}

/** The quarantined copies of an event, in stream order. */
export async function findConflicts(db: Queryable, eventId: string): Promise<EventCopy[]> {
  const result = await db.query<{ payload: TrackingEvent; subject: string; stream_sequence: string }>(
    `SELECT payload, subject, stream_sequence FROM quarantined_events
      WHERE reason = 'CONFLICT' AND event_id = $1 ORDER BY stream_sequence`,
    [eventId],
  )
  return result.rows.map((row) => ({
    event: row.payload,
    subject: row.subject,
    // bigint is read as a string.
    streamSequence: Number(row.stream_sequence),
  }))
}

/** Updates a quarantined copy to another kept copy; detected_at stays. */
export async function updateConflict(db: Queryable, conflict: Conflict): Promise<void> {
  await db.query(
    `UPDATE quarantined_events SET shipment_id = $2, details = $3
      WHERE reason = 'CONFLICT' AND stream_sequence = $1`,
    [conflict.copy.streamSequence, conflict.shipmentId, JSON.stringify(conflict.differingFields)],
  )
}

/** Removes a copy that is no conflict any more: it equals the new kept copy. */
export async function deleteConflict(db: Queryable, copy: EventCopy): Promise<void> {
  await db.query(`DELETE FROM quarantined_events WHERE reason = 'CONFLICT' AND stream_sequence = $1`, [
    copy.streamSequence,
  ])
}
