# ADR-0005: Quarantine conflicting events

Status: Accepted (recorded 2026-11-07)

## Context

Copies with the same `eventId` are expected retries (R1 in
[`docs/tracking-projection.md`](../tracking-projection.md)). A producer bug could instead send two
different events under the same `eventId` ([AC-12](../acceptance-scenarios.md)).

## Decision

- Copies with the same `eventId` may differ only in `receivedAt`. Any other difference, in the
  envelope or the payload, is a conflict.
- Conflicting events are quarantined and not projected.
- Implementation: lesson 3.1 (not implemented yet).

## Consequences

- Positive: the projection can assume duplicates are identical.
- Negative: a quarantine store and a way to inspect it are needed.

## Rejected alternatives

- Silently keeping the first or the last copy: hides a producer bug and loses information.
