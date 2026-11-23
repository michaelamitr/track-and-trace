# ADR-0013: Shared infrastructure packages

Status: Accepted (recorded 2026-11-23)

## Context

Scan Ingestion copied its HTTP code (app setup, error handling, health routes) from the Shipment
Service, and Tracking would be the third copy. Tracking also needs the database helpers that so
far exist only in Shipment. Some of this code carries rules that must be the same everywhere, such
as the error body and readiness
([ADR-0012](0012-readiness-reflects-request-path.md)).

The assignment (5.1) requires that shared packages do not hide coupling of databases or of
business logic between the services. So sharing needs a boundary that can be checked in review.

## Decision

Two new workspace packages, `@tt/db` ([`packages/db`](../../packages/db/src)) and `@tt/http`
([`packages/http`](../../packages/http/src)).

**Rule:** they contain only technical infrastructure – no tables, no queries on data, no business
logic, no domain types. Every service keeps its own database, its own migration files, its own
roles, its own errors and its own config. The packages get everything specific to a service as a
parameter and never import from a service.

| | In the package | Stays in each service |
|---|---|---|
| `@tt/db` | `createPool`, `withTransaction`, `DatabaseUnavailableError` and its detection; `runMigrations` and `verifyNoPendingMigrations` for a given directory; the body of the migrate CLI | the database, its roles and URLs, the migration `.sql` files and their tests, every table and query, the outbox and its relay |
| `@tt/db/testing` | `startPostgres` (Testcontainers) | which role and database a test connects to |
| `@tt/http` | `createHttpApp` (Zod, Swagger, 404 handler, logger), the error body and the shared error codes, `NotFoundError`, the error handler with the generic cases, the health routes (ADR-0012) | routes, schemas, title and description, own error codes, the mapping of own errors, the checks and which of them are required, `config.ts` |

Two clarifications of the rule:

- `@tt/db` reads and writes one table, `pgmigrations`, in the database of the service that calls
  it. It is the bookkeeping of node-pg-migrate ([ADR-0008](0008-database-access-and-migrations.md)),
  not service data.
- `@tt/db/testing` runs all of `infra/postgres/init` and therefore has one map with a test password
  for every role created there. It is used only in tests and knows no tables; a new service adds
  its entries.

## Consequences

- Positive: the error body, readiness and transaction handling are implemented and tested once; a
  fix reaches every service.
- Positive: a new service (Tracking) writes only its own routes, tables and error mapping.
- Positive: each service still owns its data: no package gives access to another service's
  database.
- Negative: a change in a package affects every service that uses it; the tests of all services
  must run.
- Negative: the rule is checked in review, not by a tool.
- Neutral: the packages are used as TypeScript sources in the monorepo, so there is no versioning
  between a package and the services.

## Rejected alternatives

- Keeping copies in every service: the code drifts apart, and with Tracking there would be three
  copies.
- One shared "common" package: it has no boundary, so it grows until it holds business logic too;
  Scan Ingestion would also depend on database code it does not need.
