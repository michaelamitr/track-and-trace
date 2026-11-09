# ADR-0007: Idempotent shipment registration

Status: Accepted (recorded 2026-11-09); implementation planned, lesson 2.2

## Context

The e-shop registers shipments with `POST /shipments` ([shipment-api.md](../shipment-api.md)).
A response can be lost and publishing `shipment.registered` can fail, so the e-shop must be able
to retry. A retry must not create a second shipment.

## Decision

- `orderReference` is unique in `shipment_db`.
- A repeated request with the same data returns the existing shipment (`200`) and republishes
  `shipment.registered` with the stored `eventId`.
- The same `orderReference` with different data returns `409`.

## Consequences

- Positive: retries are safe, and a retry also repairs a failed publish.
- Neutral: the `eventId` is stored with the shipment, and a retry must reuse it, never generate a new one.
- Limitation (accepted for the MVP): one order = one shipment, see Simplifications in docs/shipment-api.md.

## Rejected alternatives

- No protection: a retry creates a duplicate shipment.
- `Idempotency-Key` header: needs an extra table and the e-shop must send the key; our natural
  key (`orderReference`) already identifies the request.
