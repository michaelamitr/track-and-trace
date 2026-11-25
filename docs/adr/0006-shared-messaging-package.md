# ADR-0006: Shared messaging package

Status: Accepted (recorded 2026-11-07, amended 2026-11-08, 2026-11-16 and 2026-11-25)

## Context

Every service publishes to or consumes from the `LOGISTICS_EVENTS` stream. The delivery guarantees
in [ARCHITECTURE.md](../../ARCHITECTURE.md) only hold if every service follows the same rules:
duplicate detection on publish, validation, and an ack only after the work is committed. The
stream and the durable consumers also need one agreed configuration.

## Decision

- One package, `@tt/messaging` ([`packages/messaging`](../../packages/messaging/src)), owns the
  stream and consumer configuration as code.
- A setup step (`pnpm nats:setup`, later a one-shot container in compose) creates and updates the
  stream and the durable consumers to the declared config (`setupNats`). Services only verify
  them at startup (`verifyStream`, `verifyConsumer`) and fail fast if they are missing.
- It also owns the publish and consume rules:
  - `publishEvent` validates the event with `LogisticsEventSchema` and publishes with
    `msgID = eventId`, so a retried publish within the duplicate window is stored once.
  - `consumeEvents` validates every message, acks only after the handler resolves and naks when
    it throws. Invalid messages are terminated (`term`), because redelivery cannot fix them.
- Services use only this package to talk to NATS and the official `@nats-io/*` v3 clients.

## Consequences

- Positive: the rules are implemented and tested once, with integration tests against a real
  NATS server; a config change is reviewed and versioned with the code.
- Positive: only the setup step needs rights to manage the stream and consumers; services do not
  (least privilege, lesson 2.5).
- Positive: config changes are applied once, at deploy, not by whichever service starts next.
- Negative: every service depends on the package, and a change to it affects all of them.
- Negative: services cannot start before the setup step has run.
- A handler must commit its database transaction before it resolves, and must be idempotent by
  `eventId`, because a failed ack or a nak leads to redelivery.

## Amendment 2026-11-16

`msgID = eventId` is no longer a rule for every producer but a per-producer choice. The Shipment
Service keeps it; Scan Ingestion publishes without `msgID`, so copies with the same `eventId` are
not dropped by JetStream and conflicts reach Tracking
([ADR-0010](0010-scan-ingestion-publishing.md)).

## Amendment 2026-11-25

The behaviour of `consumeEvents` on failure is defined in
[ADR-0015](0015-consumer-failure-handling.md): transient errors are retried inside the service,
permanent errors are naked with a growing delay and quarantined from the 5th delivery on, and
invalid messages are quarantined and acked instead of terminated. `max_deliver` is unlimited. The
ack after the handler resolves is unchanged.

## Rejected alternatives

- Each service talks to NATS on its own: the publish and ack rules drift between services.
- Creating the stream by hand or in compose: the config is not versioned with the code and
  differs between environments.
- Each service calls `ensureStream` and `ensureConsumer` on start: every service needs rights to
  change the stream, and during a deploy old and new versions overwrite each other's config.
- Terraform or Kubernetes (NACK): too heavy for this project.
- The stream by the setup step, consumers by each service: services would still need rights to
  change consumers.
