# Architecture Decision Records

- [ADR-0001](0001-monorepo-with-shared-contracts.md): pnpm monorepo with a shared `@tt/contracts` package holding only subjects, schemas and types.
- [ADR-0002](0002-notification-keeps-recipient-from-registration.md): Notification stores `recipientId` from `shipment.registered` instead of calling Shipment.
- [ADR-0003](0003-self-describing-versioned-events.md): the envelope carries `eventType`, `eventVersion` and `producer`; subjects are versioned.
- [ADR-0004](0004-deterministic-tracking-projection.md): the tracking projection is a pure function that gives the same result for any delivery order.
- [ADR-0005](0005-quarantine-conflicting-events.md): copies with the same `eventId` that differ in anything other than `receivedAt` are quarantined.
- [ADR-0006](0006-shared-messaging-package.md): `@tt/messaging` owns the stream and consumer configuration as code and the publish/consume rules.
- [ADR-0007](0007-idempotent-shipment-registration.md): `orderReference` is unique; a repeated registration returns the existing shipment (`200`) without publishing again; different data → `409` (amended 2026-11-10).
- [ADR-0008](0008-database-access-and-migrations.md): plain SQL with `pg`; SQL migrations with node-pg-migrate run by `pnpm db:migrate` as `shipment_owner`; the service runs as `shipment_service` (data only).
- [ADR-0009](0009-transactional-outbox.md): events are written to an `outbox` table in the same transaction as the data and published by a relay inside the service (`FOR UPDATE SKIP LOCKED`, published rows kept).

ADRs are not edited after acceptance; a changed decision gets a new ADR and the old one is marked "Superseded by ADR-000N".
