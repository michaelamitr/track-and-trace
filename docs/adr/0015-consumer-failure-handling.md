# ADR-0015: Consumer failure handling

Status: Accepted (recorded 2026-11-25)

Amends [ADR-0005](0005-quarantine-conflicting-events.md),
[ADR-0006](0006-shared-messaging-package.md),
[ADR-0010](0010-scan-ingestion-publishing.md) and
[ADR-0014](0014-tracking-stores-every-message.md). Designed, not implemented yet (lesson 3.4).

## Context

`consumeEvents` in `@tt/messaging` ([ADR-0006](0006-shared-messaging-package.md)) treats every
failure of a handler the same way: an immediate `nak`. With `max_deliver` 5 and no delay, the five
deliveries are used up in a fraction of a second, so:

- a database outage silently skips messages: each one fails five times, stays in the stream and is
  not delivered again, although nothing is wrong with it;
- a message with a real problem ends the same way and leaves only log lines.

An invalid message (not JSON, or not a valid event) is terminated (`term`). It also leaves only a
log line, but AC-10 ([acceptance-scenarios.md](../acceptance-scenarios.md)) requires a traceable
quarantine.

The shutdown has no time limit, and neither has an SQL statement, so one stuck statement can block
the consumer and the shutdown.

## Decision

### 1. Classification

An error is **transient** only if it is of a kind known to go away by waiting: the database is
unavailable (`DatabaseUnavailableError`) or a query hit its time limit (rule 6). Every other error
is **permanent**. The one exception is writing to the quarantine, where every failure is transient
(rule 4).

Each service passes its own classification to `@tt/messaging`; the shared package does not know
the database ([ADR-0013](0013-shared-infrastructure-packages.md)).

### 2. Transient error: wait

The consumer retries the **same message inside the service**, with backoff 1 s, 2 s, 4 s … capped
at 30 s, without a limit, until it succeeds.

- The message is not returned to NATS meanwhile. The consumer signals "still working", so
  `ack_wait` (30 s) does not expire and no delivery attempts are used up.
- Messages are taken one at a time, so while one message waits for the database, no other message
  is taken: consumption pauses and the messages wait in the stream.
- Every failed retry is logged as a warning and the recovery is logged once, like the outbox relay
  does ([ADR-0009](0009-transactional-outbox.md)).

### 3. Permanent error: retry later, then quarantine

`max_deliver` is unlimited, so NATS never gives up on a message. The consumer decides, by the
delivery on which the permanent error happened:

| Delivery | Then |
|---|---|
| 1st | `nak`, delivered again after 1 s |
| 2nd | `nak`, delivered again after 5 s |
| 3rd | `nak`, delivered again after 30 s |
| 4th | `nak`, delivered again after 2 min |
| 5th or later | written to the quarantine with reason `PROCESSING_FAILED` and the error text, then acked |

A naked message does not block the others; the consumer continues with the next one.

Deliveries caused by restarts during an outage count too, so a message may reach the quarantine
after fewer permanent failures. That is safe: a message ends either processed or in the quarantine,
never silently dropped.

### 4. Invalid message: quarantine

A message that cannot be parsed as JSON or fails `LogisticsEventSchema` is written to the
quarantine with reason `INVALID` and then acked. The quarantine row has the raw message, the
subject, the stream sequence and what was wrong. This replaces the `term` of ADR-0006 (AC-10).

Writing to the quarantine, for both reasons:

- The raw message is stored as bytes (`bytea`), so the write cannot fail because of its content.
  `GET /quarantine` returns it decoded as UTF-8 text with invalid bytes replaced.
- Any other failure to write is a transient error (rule 2): it is retried, and the message is never
  acked without a record (assignment 11.4).

The quarantine of the Tracking Service is `quarantined_events`, with the reasons `INVALID` and
`PROCESSING_FAILED`. The operational endpoint `GET /quarantine`
([tracking-api.md](../tracking-api.md#get-quarantine-operational)) lists it. It is for operators,
not customers, and has no authentication (MVP). SLA monitoring and Notification will each have
their own quarantine table in their own database and their own `GET /quarantine`, following the
same rules from `@tt/messaging`.

Reprocessing a quarantined message is a manual procedure ([RUNBOOK.md](../../RUNBOOK.md)), not a
feature.

### 5. Shutdown

All services, on `SIGTERM` or `SIGINT`: stop taking messages, let the message in progress finish,
then close HTTP and the connections. The whole shutdown has at most 8 seconds, because Docker kills
the process 10 seconds after `SIGTERM`.

- A message that is waiting for the database (rule 2) at that moment is not acked; NATS delivers
  it again after the restart, however many times it has been delivered (rule 3).
- Closing the NATS connection must not fail the shutdown when NATS is unavailable.

### 6. Time limits

| What | Limit |
|---|---|
| Every SQL statement of a service's own pool (the `*_service` roles) | 5 s (`statement_timeout`); hitting it is a transient error in a consumer and `503` (dependency unavailable) in an HTTP request, like an unavailable database |
| The same statements, measured by the client | 6 s (`query_timeout`), slightly above `statement_timeout`, so the server limit normally fires first; covers a connection that silently stops answering. Hitting it is a transient error in a consumer and `503` in an HTTP request |
| Acquiring a connection from a service's own pool (the `*_service` roles) | 5 s (`connectionTimeoutMillis`, unchanged); hitting it is a transient error in a consumer and `503` in an HTTP request |
| Migrations (the `*_owner` roles) | no statement limit |
| NATS publish | 5 s (unchanged) |
| Health checks | 2 s (unchanged) |

## Consequences

- Positive: a database outage pauses processing instead of skipping messages; when the database is
  back, processing continues where it stopped, without manual work.
- Positive: one poison message neither stops processing nor disappears: it is retried for about
  2.5 minutes and then kept with its error.
- Positive: no message is silently dropped; NATS delivers it until it is processed or quarantined.
- Positive: quarantined messages can be listed with the reason and the raw message (AC-10).
- Positive: the retry rules are implemented and tested once, in `@tt/messaging`; each service
  decides only which of its errors are transient.
- Negative: an error wrongly classified as transient pauses the consumer for as long as it lasts. A
  statement that always hits its time limit for one message does this too. It is visible in the
  warnings and the growing backlog.
- Negative: an unknown temporary problem that lasts longer than the delays ends in the quarantine
  and needs manual work.
- Negative: a quarantined message is missing in the read model until it is reprocessed.
- Negative: a naked message is processed after messages that follow it in the stream. Tracking does
  not depend on the order (ADR-0014).
- Negative: deliveries are counted by NATS, not by the kind of failure. A restart while a message
  waits (rule 2), or a NATS outage that stops the "still working" signals, adds one, so the message
  may be quarantined after fewer retries than in rule 3.
- Negative: if the quarantine cannot be written although the database works, the message pauses the
  consumer until the cause is fixed.
- Negative (remaining risk): only an error the consumer can catch leads to the quarantine. A message
  that ends the process every time is delivered again without a limit, and one whose handler never
  returns for a reason other than the database blocks the consumer. Both must be found by the
  backlog and the logs.
- Negative: without authentication, anyone who can reach the port of Tracking can read the raw
  quarantined messages.
- Neutral: the quarantine is written before the ack, so a lost ack can lead to a second delivery of
  a quarantined message. `stream_sequence` is unique in `quarantined_events`, so it stays there
  once.

## Rejected alternatives

- Every error is transient: one poison message stops processing for good.
- Every error is permanent: a database outage quarantines everything.
- Retrying transient errors with `nak`: each retry is a new delivery and looks like a message
  problem.
- `max_deliver` 5 in NATS: if the 5th delivery is interrupted (a restart or a NATS outage), NATS does
  not deliver the message again and it is neither processed nor quarantined.
- The raw message as `text`: Postgres rejects some content (a NUL byte), so the write could fail
  because of the message.
- Quarantine on the first permanent failure: short problems that were not recognised as transient
  would need manual work.
