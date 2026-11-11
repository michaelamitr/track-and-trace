# ADR-0009: Transactional outbox

Status: Accepted (recorded 2026-11-10)

## Context

The Shipment Service saves a shipment in `shipment_db` and must publish `shipment.registered`
to NATS. A database and a broker cannot be written in one transaction (dual write): publishing
inside the request either loses the event when the process crashes between the two writes, or
fails the request when NATS is down although the shipment is saved. AC-06 requires the event to
be published reliably after a broker outage.

## Decision

- The request writes the shipment and an `outbox` row in the **same transaction**. The row holds
  the subject and the complete event envelope (`payload`), so publishing needs nothing else.
- An outbox relay runs **inside the service process**
  ([`outbox/relay.ts`](../../apps/shipment-service/src/outbox/relay.ts)). It **polls** the table
  about every second. Each round, in one transaction, it selects unpublished rows ordered by
  `created_at` with `FOR UPDATE SKIP LOCKED`, publishes each to its stored subject with
  `publishEvent` (`msgID` = `eventId`, waits for the ack), sets `published_at = now()` and
  commits. If publishing fails, the round rolls back and is retried with capped exponential backoff.
- Published rows are **kept**, with `published_at` set.
- Table and index: [`migrations/…_create-outbox.sql`](../../apps/shipment-service/migrations).

## Consequences

- Positive: a saved shipment always gets its event, and an event is only published for a saved
  shipment. A NATS outage does not fail registrations (AC-06).
- Positive: several service instances can run relays at the same time; `SKIP LOCKED` gives each
  row to one of them without blocking the others.
- Negative: publishing is **at-least-once**. If the commit fails after a successful publish, the
  row is published again; the copy is dropped by `Nats-Msg-Id` within the stream's duplicate
  window and by the consumers' inbox (idempotent by `eventId`).
- Negative: row locks and a database connection are held while waiting for the NATS acks of a
  batch. Acceptable for small batches; nothing else updates outbox rows.
- Neutral: up to about one polling interval of extra latency. With several relays, events of
  different shipments may be published slightly out of order; consumers order by `occurredAt`
  (ADR-0004), not by arrival.
- Neutral: the table grows; a cleanup of old published rows can be added later.

## Rejected alternatives

- Publishing inside the request (dual write): loses events on a crash between the two writes,
  and a NATS outage fails registrations.
- `LISTEN/NOTIFY` to wake the relay: more moving parts (a dedicated connection, reconnect
  handling), and notifications are lost while the relay is down, so polling is still needed.
- Deleting published rows: no audit trail of what was published and when.
- A separate relay service: the assignment allows exactly five services.
