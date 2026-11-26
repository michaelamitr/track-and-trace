# Runbook

Operational procedures for Track & Trace. The rules behind them are in
[ADR-0015](docs/adr/0015-consumer-failure-handling.md).

Status: draft. The quarantine and `GET /quarantine` exist in the Tracking Service; SLA monitoring
and Notification are planned.

The `nats` commands need the [NATS CLI](https://github.com/nats-io/natscli); it is not part of the
compose images. SQL on `tracking_db`:

```sh
docker compose exec postgres psql -U postgres -d tracking_db
```

## Checking the consumer backlog

```sh
nats consumer info LOGISTICS_EVENTS tracking
```

The consumers are `tracking`, `sla-monitoring` and `notification`. The services of the last two are
planned; until then their backlog only grows.

| Line | Meaning |
|---|---|
| Unprocessed Messages | Messages for this consumer that have not been delivered yet: the backlog. Near 0 in normal operation. |
| Redelivered Messages | Messages delivered more than once and not acked yet: being retried after a failure. Not a total over time. |
| Acknowledgment Floor | Every message up to this stream sequence is acked. One message waiting for a retry holds it back, even if later messages are done. |

| What you see | Likely meaning |
|---|---|
| Unprocessed grows, floor does not move | The consumer is not taking messages. It is stopped, or it waits for the database: check `GET /health/ready` and the warnings `transient error, retrying the message` in the log. Processing continues by itself once the database is back. |
| The same, the database is fine, and the warnings say `already quarantined with another message` | The stream was reset without `tracking_db` ([ADR-0014](docs/adr/0014-tracking-stores-every-message.md)): a stream sequence is quarantined with other bytes. Writing to the quarantine is retried without a limit, so the consumer stays paused until the stream and `tracking_db` are reset together. |
| Unprocessed near 0, Redelivered above 0 | Single messages fail with permanent errors and wait for their next attempt. After about 2.5 minutes they are in the quarantine. |
| Unprocessed grows, the service restarts again and again, or the log stops at one message | One message ends the process or never finishes. It does not reach the quarantine (ADR-0015, remaining risk); find its stream sequence just above the floor and fix the cause. |
| Unprocessed falls, floor moves | The consumer is catching up. |

## Investigating quarantined messages

```sh
curl 'http://127.0.0.1:3003/quarantine?limit=20'
curl 'http://127.0.0.1:3003/quarantine?reason=PROCESSING_FAILED'
```

SLA monitoring and Notification will have their own quarantine and `GET /quarantine` (planned).

All fields are described in [tracking-api.md](docs/tracking-api.md#get-quarantine-operational). The
same in SQL on `tracking_db`:

```sql
SELECT id, reason, subject, stream_sequence, event_id, shipment_id, details,
       encode(raw_message, 'escape') AS raw_message, detected_at
  FROM quarantined_events
 WHERE reason = 'PROCESSING_FAILED'  -- omit for all reasons
 ORDER BY detected_at DESC, id DESC
 LIMIT 50;
```

`raw_message` is `bytea`. `encode(…, 'escape')` shows every byte (a non-ASCII one as `\nnn`), where
`GET /quarantine` replaces invalid bytes.

| Reason | Meaning | First questions |
|---|---|---|
| `INVALID` | The message is not JSON or not a valid event. Retrying cannot help. | Which producer sent it (`subject`, and `producer` in the raw message)? What is wrong (`details`)? One message, or every message of this producer since a deploy? Is the message wrong, or is Tracking older than the contract? |
| `PROCESSING_FAILED` | A valid event, but processing failed on the 5th or a later delivery. Restarts during an outage count as deliveries, so there may have been fewer failures. | What is the error (`details`), and what do the logs say for this `streamSequence`? One message, or many with the same error since a deploy? Does the error say that the stream and `tracking_db` must be reset together ([ADR-0014](docs/adr/0014-tracking-stores-every-message.md))? |

A quarantined message is not in the read model. Check what the customer sees with
`GET /tracking/:shipmentId`, if the `shipmentId` is known.

## Reprocessing a quarantined message

A manual procedure. **Nothing here is automated**: there is no reprocess endpoint and no "resolved"
mark, the row stays in `quarantined_events`, and nothing checks that the message was reprocessed.

Publishing stores a new message in the stream, and every consumer of the subject receives it.
Consumers are idempotent by `eventId` (planned in SLA monitoring and Notification).

### PROCESSING_FAILED

1. Find and fix the cause, and deploy the fix. Without it the message returns to the quarantine.
2. Save the raw message, byte for byte:

   ```sh
   docker compose exec -T postgres psql -U postgres -d tracking_db -At \
     -c "SELECT encode(raw_message, 'base64') FROM quarantined_events WHERE id = <id>" \
     | base64 -d > message.json
   ```

3. Publish it unchanged to the same `subject`, with the same `eventId` and without `Nats-Msg-Id`,
   which could make the stream drop it as a duplicate:

   ```sh
   nats pub --jetstream --force-stdin <subject> < message.json
   ```

4. Check that the event is in `GET /tracking/:shipmentId/history` and that `GET /quarantine` has no
   new row for this `eventId`.
5. Note the `id` and the new stream sequence in the incident record.

### INVALID

Do not publish an invalid message unchanged; it returns to the quarantine.

1. Find out who is wrong:
   - **The producer:** fix it first, so that no more invalid messages are sent.
   - **Tracking** (older than the contract): deploy the new version, then continue as for
     `PROCESSING_FAILED`, from step 2.
2. Get the correct data from its owner (the Shipment Service or the scanner). Do not guess missing
   values.
3. Send the correct event:
   - a scan: the scanner sends it again with `POST /scans` and the same `eventId`;
   - `shipment.registered`: `POST /shipments` does not publish again
     ([ADR-0007](docs/adr/0007-idempotent-shipment-registration.md)), so publish the corrected
     message by hand, as in step 3 above.
4. Check the result as in steps 4 and 5 above.

## Shipments waiting for registration

Scans that arrive before `shipment.registered` are stored and evaluated when it arrives (AC-11).
Until then the API answers `404`. These shipments, on `tracking_db`:

```sql
SELECT shipment_id,
       count(DISTINCT event_id) AS scans,
       min(received_at)         AS first_received_at,
       max(received_at)         AS last_received_at
  FROM received_messages
 GROUP BY shipment_id
HAVING count(*) FILTER (WHERE event_type = 'shipment.registered') = 0
 ORDER BY first_received_at;
```

When to worry:

- **Not yet:** a few shipments, waiting for seconds. Also while Tracking is catching up (see
  [Checking the consumer backlog](#checking-the-consumer-backlog)).
- **Worry:** a shipment still waits after several minutes without a backlog, or the list keeps
  growing.

Where to look, in this order:

1. `GET /shipments/:shipmentId` in the Shipment Service. `404`: the shipment was never registered;
   the scan probably has a wrong `shipmentId`.
2. It exists: is the event still in the outbox? In `shipment_db`:

   ```sql
   SELECT event_id, created_at
     FROM outbox
    WHERE published_at IS NULL AND payload->>'shipmentId' = '<shipmentId>';
   ```

   A row means that the relay has not published it; check NATS and the log of the relay.
3. It was published: look for it in `GET /quarantine`.

## To be added in later lessons

The rest of the runbook: further procedures required by the assignment.
