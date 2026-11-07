# ADR-0003: Self-describing, versioned events

Status: Accepted (recorded 2026-11-07)

## Context

Events travel on NATS subjects of the form `logistics.<entity>.<event>.v<version>`. A stored event
loses its subject, but replay and the discriminated union `LogisticsEventSchema` still need to know
what the event is and which schema applies.

## Decision

- The envelope carries `eventType`, `eventVersion` and `producer`.
- v1 schemas pin `eventVersion` to `1` and `producer` per event type
  ([`events.ts`](../../packages/contracts/src/events.ts)).
- Subjects end with `.v1` ([`subjects.ts`](../../packages/contracts/src/subjects.ts)).

## Consequences

- Positive: an event describes itself without its subject (replay, discriminated union).
- Negative: a breaking change means a new version (new schema and subject).
- Negative: consumers support both versions during a migration.

## Rejected alternatives

- Relying on the subject only: a stored event loses its subject and could no longer be identified.
