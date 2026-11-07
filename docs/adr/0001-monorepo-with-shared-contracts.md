# ADR-0001: Monorepo with a shared contracts package

Status: Accepted (recorded 2026-11-07)

## Context

Several services (Shipment, Scan Ingestion, Tracking, SLA Monitoring, Notification) exchange
events over NATS JetStream. Producers and consumers must agree on subjects and payloads, and a
message from the broker can still be invalid at runtime.

## Decision

- A pnpm workspaces monorepo.
- `@tt/contracts` ([`packages/contracts`](../../packages/contracts/src)) holds only subjects, Zod
  schemas and the types inferred from them. No business logic.
- Consumers validate incoming messages with `safeParse`, so an invalid message does not crash them.

## Consequences

- Positive: one source of truth; a contract change breaks `typecheck` in every affected service.
- Negative: all services depend on the contracts package, so a breaking change needs a new event
  version (see [ADR-0003](0003-self-describing-versioned-events.md)).

## Rejected alternatives

- Copying types into each service: the copies drift apart.
- A separately published package: release overhead for a single repository.
