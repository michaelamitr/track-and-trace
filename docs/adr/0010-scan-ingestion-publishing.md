# ADR-0010: Scan ingestion publishes synchronously without broker deduplication

Status: Accepted (recorded 2026-11-16)

## Context

Scanners send scans with `POST /scans` ([scan-ingestion-api.md](../scan-ingestion-api.md)). The
scanner assigns the `eventId` and keeps the scan until it gets a success response, so it retries
with the same `eventId` after an error or a lost response (AC-07). The service has no data of its
own: it validates a scan, turns it into a `parcel.*` event and publishes it.

[ADR-0006](0006-shared-messaging-package.md) publishes every event with `msgID = eventId`. For
the Shipment Service this is safe: the service generates the `eventId`, and the content for one
`eventId` never changes. For scans the `eventId` comes from outside, and two different scans can
carry the same `eventId` (a scanner bug). Such conflicts must stay traceable (AC-12), and
duplicates must reach the consumers so that consumer deduplication can be demonstrated (AC-02).

## Decision

- The service has **no database and no outbox**. It publishes inside the request and answers
  `202 Accepted` only after the JetStream publish ack. The response body is
  `{ "eventId": "<normalized eventId>" }`. If NATS does not confirm the publish (not connected or
  the publish times out with the NATS client default), it answers `503` and the scanner retries.
- Scan events are published **without `Nats-Msg-Id`**, so JetStream does not deduplicate them.
  Every copy reaches the consumers, which deduplicate by `eventId` and keep the earliest
  `receivedAt` (R1, [ADR-0004](0004-deterministic-tracking-projection.md)) and quarantine copies
  that differ in anything else ([ADR-0005](0005-quarantine-conflicting-events.md)).
- The Shipment Service keeps `msgID = eventId`.

This changes the "`msgID = eventId`" rule of ADR-0006 into a per-producer choice.

## Consequences

- Positive: a conflicting scan (same `eventId`, different content) always reaches Tracking and is
  quarantined, whenever it is sent (AC-12).
- Positive: duplicates are visible in the stream, so consumer deduplication can be shown (AC-02).
- Positive: no database, no relay; `202` means the scan is stored in the stream.
- Negative: a retry after a lost response, or a retry of a scan that already got `202`, stores a
  second copy (same `eventId`, different `receivedAt`). Consumers must deduplicate; they must do
  so anyway because delivery is at-least-once.
- Negative: while NATS is down, scans are rejected with `503` and the scanner has to keep them
  until NATS is back.
- Negative: `@tt/messaging` must allow publishing without `msgID`.

## Rejected alternatives

- `msgID = eventId`: a different scan with the same `eventId` sent within the duplicate window is
  silently dropped by JetStream, so the conflict never reaches Tracking; it also hides consumer
  deduplication in the demo.
- `msgID = eventId` + a fingerprint of the scan content without `receivedAt`: would work (identical
  copies dropped, conflicts kept), but adds complexity for little gain – identical copies are cheap
  and consumers must deduplicate anyway.
- An outbox or a local database: the scanner already keeps the scan until it gets `202`, and the
  service has no data of its own.
- A synchronous check that the shipment exists: couples scan ingestion to Shipment availability,
  and a scan may arrive before the registration (AC-11).
