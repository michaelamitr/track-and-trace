import type pg from 'pg'
import { subjectForEvent, type LogisticsEvent } from '@tt/contracts'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

/** Writes an event to the outbox. Call it in the transaction that changes the data the event describes. */
export async function insertOutboxEvent(db: Queryable, event: LogisticsEvent): Promise<void> {
  await db.query(`INSERT INTO outbox (event_id, subject, payload) VALUES ($1, $2, $3)`, [
    event.eventId,
    subjectForEvent(event),
    JSON.stringify(event),
  ])
}
