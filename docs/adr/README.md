# Architecture Decision Records

- [ADR-0001](0001-monorepo-with-shared-contracts.md): pnpm monorepo with a shared `@tt/contracts` package holding only subjects, schemas and types (amended 2026-11-23).
- [ADR-0002](0002-notification-keeps-recipient-from-registration.md): Notification stores `recipientId` from `shipment.registered` instead of calling Shipment.
- [ADR-0003](0003-self-describing-versioned-events.md): the envelope carries `eventType`, `eventVersion` and `producer`; subjects are versioned.
- [ADR-0004](0004-deterministic-tracking-projection.md): the tracking projection is a pure function that gives the same result for any delivery order.
- [ADR-0005](0005-quarantine-conflicting-events.md): copies with the same `eventId` that differ in anything other than `receivedAt` are conflicts and are not projected (amended 2026-11-25).
- [ADR-0006](0006-shared-messaging-package.md): `@tt/messaging` owns the stream and consumer configuration as code and the publish/consume rules (amended 2026-11-25).
- [ADR-0007](0007-idempotent-shipment-registration.md): `orderReference` is unique; a repeated registration returns the existing shipment (`200`) without publishing again; different data → `409` (amended 2026-11-10).
- [ADR-0008](0008-database-access-and-migrations.md): plain SQL with `pg`; SQL migrations with node-pg-migrate run by `pnpm db:migrate` as `shipment_owner`; the service runs as `shipment_service` (data only).
- [ADR-0009](0009-transactional-outbox.md): events are written to an `outbox` table in the same transaction as the data and published by a relay inside the service (`FOR UPDATE SKIP LOCKED`, published rows kept).
- [ADR-0010](0010-scan-ingestion-publishing.md): Scan Ingestion has no database or outbox, answers `202` after the JetStream ack and publishes without `Nats-Msg-Id`; `msgID = eventId` becomes a per-producer choice (amends ADR-0006) (amended 2026-11-25).
- [ADR-0011](0011-tracking-read-model.md): Tracking stores every event once in `tracking_events` (also the inbox), recomputes the shipment with `project()` per message into `shipment_tracking` and `tracking_history` once it is registered, and quarantines conflicts in `quarantined_events` (amends ADR-0005) (amended 2026-11-23). Superseded by ADR-0014.
- [ADR-0012](0012-readiness-reflects-request-path.md): "ready" means the service can answer its HTTP requests; other dependencies are reported only for information (amended 2026-11-23).
- [ADR-0013](0013-shared-infrastructure-packages.md): `@tt/db` and `@tt/http` hold only technical infrastructure (no tables, queries on data, business logic or domain types); every service keeps its own database, migrations, roles, errors and config.
- [ADR-0014](0014-tracking-stores-every-message.md): Tracking stores every processed stream message in `received_messages`, never changes it, and computes the read model, including the conflicts, from all stored copies with `resolveCopies()` and `project()` (supersedes ADR-0011, amends ADR-0005) (amended 2026-11-25).
- [ADR-0015](0015-consumer-failure-handling.md): consumers retry transient errors inside the service without a limit, retry permanent errors with a growing delay and quarantine them from the 5th delivery on, and quarantine invalid messages; also shutdown and SQL time limits (amends ADR-0005, ADR-0006, ADR-0010 and ADR-0014).

A decision is not rewritten after acceptance. A smaller change is recorded as a dated "Amendment" section in the same ADR; a replaced decision gets a new ADR and the old one is marked "Superseded by ADR-000N".
