# ADR-0004: Deterministic tracking projection

Status: Accepted (recorded 2026-11-07)

## Context

Delivery is at-least-once (duplicates), events can arrive out of order, and a replay must give the
same result as the original processing.

## Decision

Tracking derives a shipment's state with rules R1–R6, defined in
[`docs/tracking-projection.md`](../tracking-projection.md). In short: duplicates by `eventId` are
counted once and the copy with the earliest `receivedAt` is kept (R1); events are ordered by
`occurredAt`, lifecycle phase and `eventId`, never by arrival (R2); the first `DELIVERED` is final
and later events are anomalies (R3–R6). `project()` is a pure function of the shipment's events.

## Consequences

- Positive: the same result for any input order.
- Positive: testable without infrastructure.
- Negative: all events of a shipment must be loaded to project it.

## Rejected alternatives

- "Last arrived wins": wrong for out-of-order events.
- "First processed copy wins": the result depends on processing order.
