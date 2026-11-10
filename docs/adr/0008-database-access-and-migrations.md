# ADR-0008: Database access and migrations

Status: Accepted (recorded 2026-11-10)

## Context

The Shipment Service is the first service with its own Postgres database (`shipment_db`).
Registration (ADR-0007) and the planned inbox and outbox need exact control over the SQL and
over transaction boundaries: a row and its event must be committed in one transaction, and
duplicates must be caught by unique constraints. The schema also has to change over time in a
reviewed, repeatable way, and the running service should have as few rights as possible
(least privilege, lesson 2.5).

## Decision

- Services access Postgres with plain SQL through the `pg` driver. No query builder or ORM.
- Schema changes are SQL migration files run by
  [node-pg-migrate](https://github.com/salsita/node-pg-migrate), one file per migration with a
  `-- Up Migration` and a `-- Down Migration` section, in
  [`apps/shipment-service/migrations`](../../apps/shipment-service/migrations).
- Migrations are run by a setup step, `pnpm db:migrate` (`pnpm db:migrate:down` reverts the
  last one), connected as `shipment_owner` through `SHIPMENT_MIGRATIONS_DATABASE_URL`. The service
  does not run migrations; at startup it will only verify that no migration is pending and fail
  fast otherwise (same pattern as `pnpm nats:setup` in ADR-0006).
- Each service database has two roles, created by
  [`infra/postgres/init/01-shipment.sh`](../../infra/postgres/init/01-shipment.sh):
  - `shipment_owner` owns the database and schema `public` and runs the migrations;
  - `shipment_service` is the runtime role (`SHIPMENT_DATABASE_URL`): it can read and write
    data in the tables, but cannot create, alter or drop them.
- Migrations are tested against a real Postgres (Testcontainers, same image as compose): up,
  the constraints and role rights as `shipment_service`, down, and up again.

## Consequences

- Positive: the SQL that runs is the SQL that was reviewed; inbox, outbox and idempotency rules
  are written and tested directly against Postgres.
- Positive: a compromised or buggy service cannot drop or alter tables.
- Positive: schema changes are applied once, at deploy, not by whichever instance starts first.
- Negative: more code to write by hand (queries, row mapping) than with an ORM.
- Negative: two connection URLs per service, and the services cannot start before the
  migration step has run.
- Down migrations must be written by hand and are covered by the integration test.

## Rejected alternatives

- Kysely, and ORMs such as Prisma or Drizzle: they hide the SQL; the inbox and outbox need exact
  control over the SQL and the transactions.
- dbmate: a separate binary outside our TypeScript tooling.
- A custom migration runner: locking, ordering and bookkeeping are already solved by
  node-pg-migrate.
- The service running migrations on start: it would need rights to change the schema.
- A single role per service: the running service could drop or alter tables.
