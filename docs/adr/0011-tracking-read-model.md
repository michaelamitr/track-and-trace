# ADR-0011: Tracking read model

Status: Accepted (recorded 2026-11-20, amended 2026-11-23)

## Context

The Tracking Service consumes `shipment.registered` and the four `parcel.*` events and answers
`GET /tracking/:shipmentId` and its history ([tracking-api.md](../tracking-api.md)). Its state
must follow from the events with rules R1–R6 ([ADR-0004](0004-deterministic-tracking-projection.md)),
whatever the delivery order and however many copies arrive:

- delivery is at-least-once, and scan copies are not deduplicated by JetStream
  ([ADR-0010](0010-scan-ingestion-publishing.md)), so processing must be idempotent by `eventId`;
- a copy with the same `eventId` but different content must be quarantined, not projected
  ([ADR-0005](0005-quarantine-conflicting-events.md), AC-12);
- a scan can arrive before the registration and must not be lost (AC-11);
- the database can be lost and rebuilt from the stream (AC-05).

`project()` is a pure function of all events of one shipment.

## Decision

### Database

`tracking_db` follows [ADR-0008](0008-database-access-and-migrations.md): roles `tracking_owner`
(migrations, `TRACKING_MIGRATIONS_DATABASE_URL`) and `tracking_service` (data only,
`TRACKING_DATABASE_URL`), created by a new init script in
[`infra/postgres/init`](../../infra/postgres/init).

### Tables

Everything in `tracking_db` is derived from the stream: it can be deleted and rebuilt by a
replay.

| Table | Key | Content |
|---|---|---|
| `tracking_events` | `event_id` | Every received event once: `shipment_id` (indexed), `event_type`, `occurred_at`, `received_at`, `payload` (the whole event, `jsonb`). The row is always the whole earliest copy (R1). It is also the inbox; there is no separate processed-events table. |
| `shipment_tracking` | `shipment_id` | One row per known shipment, upserted: `tracking_number`, `status`, `last_location`, `last_event_at`, `delivered_at`, `updated_at` (processing time). |
| `tracking_history` | `shipment_id`, `position` | The ordered history: `position` follows R2 and starts at 1 for each shipment; `event_id`, `event_type`, `status`, `occurred_at`, `received_at`, `facility_id`, `is_anomaly` (R5). |
| `quarantined_events` | `id` | A general quarantine: `reason` (`CONFLICT`; `INVALID` will be added in lesson 3.4 for invalid messages), `event_id` and `shipment_id` (both nullable for future `INVALID` rows), `subject`, `stream_sequence` (unique), `payload` (the quarantined copy), `details` (`jsonb`; for `CONFLICT` the list of differing fields), `detected_at`. |

### Processing one message

All steps run in **one** transaction; the message is acked only after the commit.

1. Insert the event into `tracking_events` with `ON CONFLICT (event_id) DO NOTHING`.
2. If the `event_id` already exists, compare the two copies ignoring `receivedAt` (see
   [Comparing copies](#comparing-copies)):
   - **equal** → a duplicate (R1): if the new copy is earlier, `payload` and `received_at` are
     replaced together, so the row stays the whole earliest copy;
   - **different** → a conflict (ADR-0005): the new copy is written to `quarantined_events`
     with reason `CONFLICT` and the differing fields, and it is **not** projected; the first
     stored copy stays.
3. Load all events of the shipment from `tracking_events` and call `project()` with their
   `payload`.
4. If a `shipment.registered` event exists for the shipment, upsert `shipment_tracking` and
   replace the shipment's rows in `tracking_history`. Otherwise store nothing else.
5. Commit, then ack.

Messages are processed one at a time by one instance.

### Unknown shipments

A shipment is known once its `shipment.registered` is stored. Scans that arrive earlier wait in
`tracking_events`; step 4 stores no tracking for them. When the registration arrives, step 3
loads them with it and the whole history is projected at once (AC-11). The HTTP API answers
`404` for a shipment that is not known, even if scans for it exist.

### Comparing copies

Time fields (`occurredAt` and any time in `data`) are compared as instants, so `09:30:00Z` and
`09:30:00.000Z` are equal; `receivedAt` is ignored. Every other field is compared exactly. This
follows the rule in [tracking-projection.md](../tracking-projection.md#the-three-moments-of-a-scan)
that times are compared as timestamps, never as strings. Differing fields are recorded by name for
envelope fields (`occurredAt`) and as `data.<field>` for payload fields (`data.scannerId`).

### Conflicts

The copy stored first, in stream order, is kept; later different copies go to
`quarantined_events`. Because one instance processes the stream in order, a replay quarantines
the same copies.

- Rows are inserted with `ON CONFLICT (stream_sequence) DO NOTHING`. A redelivery is the same
  message with the same stream sequence, so it is quarantined once; a new conflicting copy from
  a producer has a new stream sequence and gets its own row.
- `shipment_id` of the row is that of the kept copy; the conflicting copy keeps its own
  `shipmentId` in `payload`. If the two differ, the conflict belongs to both shipments.

Conflicts are shown by `GET /tracking/:shipmentId/anomalies`, under both shipments if their
`shipmentId` differs.

This implements ADR-0005 now instead of in lesson 3.1 (amends ADR-0005).

## Consequences

- Positive: one insert with `ON CONFLICT` both deduplicates and stores the event; redelivery
  after a crash before the ack is harmless, because the transaction either committed everything
  or nothing.
- Positive: the stored result is always `project()` of all stored events, so it is the same for
  any delivery order and the R1–R6 logic exists only in `project()`.
- Positive: reads are simple selects from `shipment_tracking` and `tracking_history`.
- Positive: early scans are kept without extra tables (AC-11), and the database can be rebuilt
  by a replay (AC-05).
- Positive: the quarantine table is general, so invalid messages (lesson 3.4) need no new table.
- Negative: every message loads and projects all events of its shipment and rewrites its history.
  This is cheap only while a shipment has few events.
- Negative: one instance only. Several instances could process events of the same shipment at
  the same time; that is out of scope.
- Negative: reads are eventually consistent: an accepted scan is visible only after Tracking has
  processed it.
- Negative: events of shipments that are never registered stay in `tracking_events` and are not
  visible through the API.

## Amendment 2026-11-23

The kept copy of an event is the one with the **lower stream sequence**, not the one processed
first. The two differ when the first copy fails and is redelivered after a different copy has been
stored; a replay would then keep the other copy and give a different projection.

- `tracking_events` also stores `stream_sequence` and `subject` of the kept copy. Equal copies
  keep the earliest received content (R1) and the lower stream sequence.
- If a conflicting copy has a lower stream sequence than the stored one, the stored copy is moved
  to `quarantined_events` and the new copy is stored instead, in the same transaction. Copies
  quarantined earlier are compared with the new kept copy: one that is equal becomes a duplicate,
  for the others `details` and `shipment_id` are updated. Every affected shipment is projected
  again; one that loses its registration this way is no longer known.
- Limit: equal copies that were already merged (R1) are moved as one row, so the quarantine can
  list fewer copies than a replay. The kept copy and the projection are always the same.
- The stream and `tracking_db` must always be reset together: stream sequences restart with a new
  stream, so old sequences in the database would decide conflicts wrongly and hide new quarantine
  rows.

## Rejected alternatives

- A separate inbox table: every `eventId` would be stored twice; `tracking_events` already
  enforces one row per `eventId`.
- Incremental projection (update the stored state with each new event): complex with
  out-of-order events and duplicates, and it would repeat the R1–R6 logic outside `project()`.
- Computing the history on every read: the read side would compute, against the idea of a read
  model.
- Showing unregistered shipments: a customer would see a shipment the e-shop never registered.
- Quarantine only in lesson 3.1: moved earlier, because conflict detection is written now.
