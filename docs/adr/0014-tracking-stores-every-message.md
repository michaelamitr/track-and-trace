# ADR-0014: Tracking stores every message

Status: Accepted (recorded 2026-11-23, amended 2026-11-25)

Supersedes [ADR-0011](0011-tracking-read-model.md) and amends
[ADR-0005](0005-quarantine-conflicting-events.md).

## Context

The Tracking Service consumes `shipment.registered` and the four `parcel.*` events and answers
`GET /tracking/:shipmentId`, its history and its anomalies ([tracking-api.md](../tracking-api.md)).
Its state must follow from the events with rules R1–R6
([ADR-0004](0004-deterministic-tracking-projection.md)), whatever the delivery order and however
many copies arrive:

- delivery is at-least-once, and scan copies are not deduplicated by JetStream
  ([ADR-0010](0010-scan-ingestion-publishing.md)), so processing must be idempotent by `eventId`;
- a copy with the same `eventId` but different content is a conflict and must not be projected
  (ADR-0005, AC-12);
- a scan can arrive before the registration and must not be lost (AC-11);
- the database can be lost and rebuilt from the stream (AC-05).

ADR-0011 stored one row per event. It decided which copy wins **when a message was written**, so
the result depended on the processing order: after a failure and a redelivery the messages are not
processed in stream order, and a replay then kept a different copy. An amendment let a copy with a
lower stream sequence replace the stored one. That needed moving rows between `tracking_events`
and `quarantined_events`, comparing earlier quarantined copies again, and still lost information:
equal copies that had been merged could not be separated again, so the quarantine could differ
from a replay.

## Decision

Store every message unchanged and decide nothing when writing. Everything else is computed from
the stored messages.

### Database

`tracking_db` follows [ADR-0008](0008-database-access-and-migrations.md): roles `tracking_owner`
(migrations, `TRACKING_MIGRATIONS_DATABASE_URL`) and `tracking_service` (data only,
`TRACKING_DATABASE_URL`), created by
[`02-tracking.sh`](../../infra/postgres/init/02-tracking.sh).

### Tables

Everything in `tracking_db` is derived from the stream: it can be deleted and rebuilt by a replay.

| Table | Key | Content |
|---|---|---|
| `received_messages` | `stream_sequence` | One row per stream message, only inserted, never updated or moved: `event_id` (indexed), `shipment_id` (indexed), `subject`, `event_type`, `occurred_at`, `received_at`, `payload` (the whole event, `jsonb`). It is also the inbox. |
| `shipment_tracking` | `shipment_id` | Read model: one row per known shipment: `tracking_number`, `status`, `last_location`, `last_event_at`, `delivered_at`, `updated_at` (processing time). |
| `tracking_history` | `shipment_id`, `position` | Read model: the ordered history: `position` follows R2 and starts at 1 for each shipment; `event_id`, `event_type`, `status`, `occurred_at`, `received_at`, `facility_id`, `is_anomaly` (R5). |
| `tracking_conflicts` | `shipment_id`, `stream_sequence` | Read model: the conflicting copies: `event_id`, `stream_sequence` and `received_at` of the conflicting copy, `differing_fields`. |
| `quarantined_events` | `id` | Invalid messages only (`reason` `INVALID`); written from lesson 3.4 on. |

The read model contains no wall-clock values except `shipment_tracking.updated_at` (processing
time). Every other value comes from the stored messages, so a replay gives the same read model;
therefore a conflict has the `receivedAt` of its copy and not the time when it was detected.

### Which copy counts

`resolveCopies()` is a pure function of all stored copies and does not depend on their order. For
each `event_id`:

- the **kept** copy is the one with the lowest `stream_sequence`;
- copies equal to it except for `receivedAt` are **duplicates**; the kept event gets the earliest
  `receivedAt` of them all (R1, with the tie-breaker of `project()`);
- copies that differ are **conflicts**, with their differing fields. Each is compared with the kept
  copy only.

Time fields (`occurredAt` and any time in `data`) are compared as instants, so `09:30:00Z` and
`09:30:00.000Z` are equal; `receivedAt` is ignored. Every other field is compared exactly.
Differing fields are named `occurredAt` for envelope fields and `data.<field>` for payload fields.

A conflict belongs to the shipment of the kept copy and, if it names another one, also to the
shipment of the conflicting copy. An event belongs to the shipment of its kept copy.

### Processing one message

All steps run in **one** transaction; the message is acked only after the commit.

1. Insert the message into `received_messages` with `ON CONFLICT (stream_sequence) DO NOTHING`. A
   redelivery is the same message with the same stream sequence, so it adds no row.
2. The affected shipments are those of all copies of the event. Load all their copies and the
   copies of the same events that name other shipments.
3. Call `resolveCopies()`, and `project()` with the kept events of each affected shipment.
4. For each affected shipment: if it has a `shipment.registered`, upsert `shipment_tracking` and
   replace its rows in `tracking_history` and `tracking_conflicts`. Otherwise delete its rows in the
   read model.
5. Commit, then ack.

The result in the log (`processed`, `duplicate`, `conflict`, `waiting_for_registration`) is derived
from `resolveCopies()` and from whether the message was new. Messages are processed one at a time
by one instance.

### Unknown shipments

A shipment is known once its `shipment.registered` is stored and kept. Scans that arrive earlier
wait in `received_messages`; when the registration arrives, the whole history is computed at once
(AC-11). The HTTP API answers `404` for a shipment that is not known, even if scans for it exist. A
shipment stops being known only if its registration turns out to be a conflicting copy.

### Resetting

The stream and `tracking_db` must always be reset together: stream sequences restart with a new
stream. A message whose stream sequence is already stored with another event is rejected with an
error instead of being taken for a redelivery.

## Consequences

- Positive: the result depends only on which messages are stored, so any processing order gives the
  same read model as a replay of the stream, including the list of conflicts; only `updated_at`
  differs.
- Positive: conflict resolution is one pure function, tested without a database; no rows are moved
  between tables.
- Positive: redelivery after a crash before the ack is harmless, because the transaction either
  committed everything or nothing.
- Positive: `received_messages` shows exactly what Tracking received, also every duplicate.
- Positive: reads are simple selects from the read model; early scans need no extra tables (AC-11),
  and the database can be rebuilt by a replay (AC-05).
- Negative: every copy is stored, so the table grows with every retry.
- Negative: every message loads and resolves all copies of its shipment and rewrites its read
  model. This is cheap only while a shipment has few messages.
- Negative: one instance only. Several instances could process messages of the same shipment at the
  same time; that is out of scope.
- Negative: reads are eventually consistent: an accepted scan is visible only after Tracking has
  processed it. A conflict can change which copy counts when an earlier copy is processed late.
- Negative: messages of shipments that are never registered stay in `received_messages` and are not
  visible through the API.

## Amendment 2026-11-25

Failure handling is defined in [ADR-0015](0015-consumer-failure-handling.md).

- `quarantined_events` is not for invalid messages only. It has two reasons: `INVALID` for messages
  that are not a valid event, and `PROCESSING_FAILED` for valid messages whose processing failed on
  the 5th or a later delivery. Conflicting copies are not in it; they are in `tracking_conflicts`.
  The raw message is stored as bytes. Nothing in `quarantined_events` is part of the read model.
- `received_messages` holds every message that was processed. A message in the quarantine with
  `PROCESSING_FAILED` is not in it.
- Quarantine rows are an operational record, not derived from the stream: a replay after a code fix
  may not reproduce `PROCESSING_FAILED` rows. What a rebuild does with the quarantine is decided in
  lesson 4.1.

## Rejected alternatives

- One row per event (ADR-0011): the winner is decided at write time, see Context.
- Recording only the stream sequences of merged copies: the amendment's code would grow further,
  and the copies' contents would still be lost.
- Keeping conflicting copies in `quarantined_events`: they are valid messages and follow from
  `received_messages`; the quarantine is for messages that cannot be processed.
- Incremental projection (update the stored state with each new message): complex with out-of-order
  events and duplicates, and it would repeat the R1–R6 logic outside `project()`.
- Computing the history on every read: the read side would compute, against the idea of a read
  model.
- Showing unregistered shipments: a customer would see a shipment the e-shop never registered.
