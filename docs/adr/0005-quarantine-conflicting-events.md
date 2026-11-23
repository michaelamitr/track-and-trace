# ADR-0005: Quarantine conflicting events

Status: Accepted (recorded 2026-11-07, amended 2026-11-20 and 2026-11-23)

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

## Amendment 2026-11-20

Implemented in lesson 2.4 in the Tracking Service, not in lesson 3.1: conflicting copies are
written to the general `quarantined_events` table with reason `CONFLICT`
([ADR-0011](0011-tracking-read-model.md)) and shown by `GET /tracking/:shipmentId/anomalies`
([tracking-api.md](../tracking-api.md)).

## Amendment 2026-11-23

Conflicting copies are recorded in the read model table `tracking_conflicts`, not in
`quarantined_events`, and are still not projected
([ADR-0014](0014-tracking-stores-every-message.md)). `quarantined_events` is for invalid messages
only.

## Rejected alternatives

- Silently keeping the first or the last copy: hides a producer bug and loses information.
