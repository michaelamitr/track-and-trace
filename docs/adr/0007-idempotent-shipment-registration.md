# ADR-0007: Idempotent shipment registration

Status: Accepted (recorded 2026-11-09, amended 2026-11-10)

## Context

The e-shop registers shipments with `POST /shipments` ([shipment-api.md](../shipment-api.md)).
A response can be lost, so the e-shop must be able to retry. A retry must not create a second
shipment.

## Decision

- `orderReference` is unique in `shipment_db`.
- A repeated request with the same data returns the existing shipment (`200`) and does not
  publish again. Publication is guaranteed by the outbox row written together with the shipment
  ([ADR-0009](0009-transactional-outbox.md)).
- The same `orderReference` with different data returns `409`. All request fields are compared;
  `expectedDeliveryAt` is compared as an instant.

## Consequences

- Positive: retries are safe and cheap; the e-shop never needs to retry to repair publishing.
- Neutral: the `eventId` is stored with the shipment and in its outbox row, and is never
  generated again for the same shipment.
- Limitation (accepted for the MVP): one order = one shipment, see Simplifications in docs/shipment-api.md.

## Amendment 2026-11-10

The original decision republished `shipment.registered` with the stored `eventId` on every
repeated request, so that a retry also repaired a failed publish (and answered `503` when
publishing failed). With the transactional outbox (ADR-0009) the request no longer publishes at
all: a failed publish is retried by the outbox relay, so a repeated request only returns the
existing shipment.

## Rejected alternatives

- No protection: a retry creates a duplicate shipment.
- `Idempotency-Key` header: needs an extra table and the e-shop must send the key; our natural
  key (`orderReference`) already identifies the request.
