import type { QuarantineReason, QuarantineRecord } from '@tt/messaging'
import type pg from 'pg'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

export type QuarantinedMessage = {
  id: number
  reason: QuarantineReason
  subject: string
  streamSequence: number
  eventId: string | null
  shipmentId: string | null
  details: string
  rawMessage: Buffer
  detectedAt: Date
}

/** Thrown when a stream sequence is quarantined with other bytes: the stream was reset without tracking_db. */
export class QuarantineConflictError extends Error {
  override name = 'QuarantineConflictError'
}

/**
 * Writes a message to the quarantine (ADR-0015 rule 4). A message that is
 * already there with the same stream sequence and the same bytes is a second
 * delivery after a lost ack and is left as it is. The same stream sequence with
 * other bytes means that the stream was reset without tracking_db (ADR-0014):
 * that is an error, not "already quarantined".
 */
export async function insertQuarantined(db: Queryable, record: QuarantineRecord): Promise<void> {
  // A copy: msg.data may be a view into a larger buffer.
  const raw = Buffer.from(record.rawMessage)
  const inserted = await db.query(
    `INSERT INTO quarantined_events
       (reason, event_id, shipment_id, subject, stream_sequence, raw_message, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (stream_sequence) DO NOTHING`,
    [record.reason, record.eventId, record.shipmentId, record.subject, record.streamSequence, raw, record.details],
  )
  if (inserted.rowCount === 1) return

  const { rows } = await db.query<{ raw_message: Buffer }>(
    'SELECT raw_message FROM quarantined_events WHERE stream_sequence = $1',
    [record.streamSequence],
  )
  const stored = rows[0]?.raw_message
  if (stored && stored.equals(raw)) return
  throw new QuarantineConflictError(
    `Stream sequence ${record.streamSequence} is already quarantined with another message. ` +
      'The stream and tracking_db must be reset together (ADR-0014).',
  )
}

/** The newest quarantined messages first, in ONE statement (one consistent snapshot). */
export async function findQuarantined(
  db: Queryable,
  filter: { reason?: QuarantineReason | undefined; limit: number },
): Promise<QuarantinedMessage[]> {
  const { rows } = await db.query<{
    id: string
    reason: QuarantineReason
    subject: string
    stream_sequence: string
    event_id: string | null
    shipment_id: string | null
    details: string
    raw_message: Buffer
    detected_at: Date
  }>(
    `SELECT id, reason, subject, stream_sequence, event_id, shipment_id, details, raw_message, detected_at
       FROM quarantined_events
      WHERE $1::text IS NULL OR reason = $1
      ORDER BY detected_at DESC, id DESC
      LIMIT $2`,
    [filter.reason ?? null, filter.limit],
  )
  return rows.map((row) => ({
    // bigint is read as a string.
    id: Number(row.id),
    reason: row.reason,
    subject: row.subject,
    streamSequence: Number(row.stream_sequence),
    eventId: row.event_id,
    shipmentId: row.shipment_id,
    details: row.details,
    rawMessage: row.raw_message,
    detectedAt: row.detected_at,
  }))
}
