# ADR-0012: Readiness reflects the request path

Status: Accepted (recorded 2026-11-20)

## Context

`GET /health/ready` tells a load balancer or orchestrator whether to send HTTP requests to an
instance. The services depend on different things to answer them: Shipment needs its database
(events wait in the outbox, [ADR-0009](0009-transactional-outbox.md)), Scan Ingestion needs NATS
([ADR-0010](0010-scan-ingestion-publishing.md)), and Tracking reads only its database
([ADR-0011](0011-tracking-read-model.md)). Shipment currently reports `503` when NATS is down,
although its requests still succeed.

## Decision

"Ready" means the service can answer its HTTP requests. Only the dependencies on the request
path decide `200` or `503`; other dependencies are reported in `checks` for information.

| Service | Ready when | Reported only |
|---|---|---|
| Shipment | a database query works | NATS (events wait in the outbox) |
| Scan Ingestion | NATS is connected | – |
| Tracking | a database query works | NATS (reads work without it) |

Shipment's current behaviour changes; the code and [shipment-api.md](../shipment-api.md) are
updated together in the next step. SLA monitoring and Notification follow the same rule.

## Consequences

- Positive: a NATS outage does not take Shipment or Tracking out of service: registrations are
  still accepted (AC-06) and tracking can still be read.
- Positive: one rule for every service.
- Negative: `200` no longer means "everything works". A Tracking instance without NATS is ready
  but its data grows stale, and Shipment's outbox grows; this is visible only in `checks` and the
  logs.
- Neutral: liveness (`GET /health/live`) is unchanged.

## Rejected alternatives

- Ready only when every dependency is up: a NATS outage would make services that can still read
  or write unavailable.
