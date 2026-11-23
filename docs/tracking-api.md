# Tracking API

The HTTP contract of the Tracking Service
([`apps/tracking-service`](../apps/tracking-service/src)). How the read model is stored is decided
in [ADR-0014](adr/0014-tracking-stores-every-message.md), readiness in
[ADR-0012](adr/0012-readiness-reflects-request-path.md). The status rules are in
[tracking-projection.md](tracking-projection.md), the events in [EVENTS.md](../EVENTS.md).

Default address `http://127.0.0.1:3003`. The OpenAPI document and Swagger UI are served at
`/docs` (JSON at `/docs/json`).

The service only reads its own database, `tracking_db`. It never calls NATS or another service
to answer a request.

## Eventual consistency

The read model is written by the consumer, not by the request that created the data. A scan
accepted by Scan Ingestion (`202`) or a shipment registered by the Shipment Service (`201`)
appears here only after Tracking has processed the event. Until then a `GET` returns the
previous state, or `404` for a shipment whose `shipment.registered` has not been processed yet.

## Known shipments

A shipment is known once its `shipment.registered` event has been processed. Scans that arrive
before the registration are stored and evaluated when it arrives
([AC-11](acceptance-scenarios.md)); until then every endpoint answers `404` for that shipment,
even though scans for it exist.

## Reads

The same for all three read endpoints:

- `shipmentId` is accepted in any letter case; IDs in responses are lowercase.
- All times in responses are ISO 8601 in UTC with milliseconds (`Date.toISOString()`), however the
  event wrote them: `09:30:00Z` is returned as `09:30:00.000Z`. Fractions finer than a millisecond
  are dropped.
- A response is one consistent snapshot of the read model (a single SQL statement); it never mixes
  rows from before and after a message was processed. Two requests can see different snapshots.

## GET /tracking/:shipmentId

The current state of a shipment.

Response body for `200`:

```json
{
  "shipmentId": "0d40c8bb-e48f-4311-9223-1a54a7e197e4",
  "trackingNumber": "PF-4821093375",
  "status": "AT_HUB",
  "lastLocation": "DEPOT-BRNO",
  "lastEventAt": "2026-10-28T09:30:00.000Z",
  "deliveredAt": null,
  "updatedAt": "2026-10-28T09:31:13.204Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `shipmentId` | UUID | The shipment. |
| `trackingNumber` | string | From `shipment.registered`. |
| `status` | `REGISTERED` \| `ACCEPTED` \| `AT_HUB` \| `OUT_FOR_DELIVERY` \| `DELIVERED` | Current status (R3, R4). |
| `lastLocation` | string \| `null` | `facilityId` of the event that determined the status. `null` while the status is `REGISTERED`. |
| `lastEventAt` | ISO 8601, UTC | `occurredAt` of the event that determined the status. Business time. |
| `deliveredAt` | ISO 8601, UTC \| `null` | `occurredAt` of the first `DELIVERED`. `null` before delivery. |
| `updatedAt` | ISO 8601, UTC | When Tracking last processed a message for this shipment. Processing time. |

The fields `status` to `deliveredAt` are the output of `project()`
([tracking-projection.md](tracking-projection.md#output-of-project)).

### `lastEventAt` vs `updatedAt`

`lastEventAt` says when the shipment last physically moved (scan time, `occurredAt`).
`updatedAt` says when Tracking last processed an event of the shipment. Together they help to
find out why a shipment stopped updating:

| `lastEventAt` | `updatedAt` | Likely meaning |
|---|---|---|
| old | recent | Tracking processes events for the shipment, but none moved it forward: duplicates, a late scan ordered earlier in the history (R6) or an anomaly after delivery (R5). Check the history. |
| old | old | No new events reached Tracking. Either the parcel is not being scanned, or Tracking is not processing (check `GET /health/ready`, its `nats` check and the consumer's pending messages). If other shipments have a recent `updatedAt`, Tracking is working. |
| recent | much later than `lastEventAt` | The scan reached Tracking late (scanner offline, retries, or Tracking was catching up). Compare `occurredAt` and `receivedAt` in the history. |

## GET /tracking/:shipmentId/history

The ordered history of a shipment, in R2 order (`occurredAt`, then lifecycle phase, then
`eventId`), never in arrival order. Every unique event appears once (R1), including anomalies.

Response body for `200`:

```json
{
  "shipmentId": "0d40c8bb-e48f-4311-9223-1a54a7e197e4",
  "events": [
    {
      "eventId": "5b3f7d0e-2c1a-4e8b-9f6d-3a2b1c0d9e8f",
      "eventType": "shipment.registered",
      "status": "REGISTERED",
      "occurredAt": "2026-10-28T08:00:00.000Z",
      "receivedAt": "2026-10-28T08:00:00.000Z",
      "facilityId": null,
      "isAnomaly": false
    },
    {
      "eventId": "4d36957b-6c2b-47e0-b784-13a9b00c0b67",
      "eventType": "parcel.arrived_at_hub",
      "status": "AT_HUB",
      "occurredAt": "2026-10-28T09:30:00.000Z",
      "receivedAt": "2026-10-28T09:31:12.000Z",
      "facilityId": "DEPOT-BRNO",
      "isAnomaly": false
    }
  ]
}
```

Each entry is a `HistoryEntry` of `project()`:

| Field | Type | Meaning |
|---|---|---|
| `eventId` | UUID | ID of the event. |
| `eventType` | string | Type of the event. |
| `status` | string | Status that the event type maps to, also for anomalies. |
| `occurredAt` | ISO 8601, UTC | When the event physically happened. |
| `receivedAt` | ISO 8601, UTC | When the system accepted the event; the earliest copy if it was retried (R1). |
| `facilityId` | string \| `null` | Facility of the scan. `null` for `shipment.registered`. |
| `isAnomaly` | boolean | `true` if the event is ordered after the first `DELIVERED` (R5). |

## GET /tracking/:shipmentId/anomalies

What did not fit into the normal history of a shipment.

Response body for `200`:

```json
{
  "shipmentId": "0d40c8bb-e48f-4311-9223-1a54a7e197e4",
  "afterDelivery": [
    {
      "eventId": "9a1e2b3c-4d5e-4f60-8a7b-6c5d4e3f2a1b",
      "eventType": "parcel.arrived_at_hub",
      "status": "AT_HUB",
      "occurredAt": "2026-10-29T08:15:00.000Z",
      "receivedAt": "2026-10-29T08:15:04.000Z",
      "facilityId": "DEPOT-BRNO",
      "isAnomaly": true
    }
  ],
  "conflicts": [
    {
      "eventId": "4d36957b-6c2b-47e0-b784-13a9b00c0b67",
      "streamSequence": 1042,
      "receivedAt": "2026-10-28T10:02:41.918Z",
      "differingFields": ["data.scannerId"]
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `afterDelivery` | `HistoryEntry[]` | History entries with `isAnomaly` `true` (R5), in R2 order. Same shape as in the history. |
| `conflicts` | array | From `tracking_conflicts`: copies that share an `eventId` with the kept copy of an event, the one with the lowest stream sequence, but differ in something other than `receivedAt` ([ADR-0005](adr/0005-quarantine-conflicting-events.md), [AC-12](acceptance-scenarios.md)). They are not part of the history or the status. |
| `conflicts[].eventId` | UUID | The shared `eventId`. |
| `conflicts[].streamSequence` | integer | Position of the conflicting copy in the stream. |
| `conflicts[].receivedAt` | ISO 8601, UTC | When the system accepted the conflicting copy (its own `receivedAt`). |
| `conflicts[].differingFields` | string[] | Fields that differ from the kept copy: envelope fields by name (`occurredAt`), payload fields as `data.<field>` (`data.scannerId`). |

How conflicts are listed:

- They are ordered by `streamSequence`.
- `receivedAt` is ignored, and times are compared as instants: `09:30:00Z` and `09:30:00.000Z`
  are equal, so they are not a conflict.
- A redelivery of the same message is listed once; each new conflicting copy sent by a producer
  is listed separately.
- A conflicting copy with a different `shipmentId` is listed under both shipments: the one of
  the kept copy and its own, each once that shipment is known.
- Which copy is kept does not depend on the processing order: if a copy with a lower stream
  sequence is processed later, it becomes the kept one and the list changes accordingly.

Both lists are empty when there is nothing to report. Invalid messages (quarantine reason
`INVALID`, lesson 3.4) are not part of this endpoint.

## Status codes

The same for all three read endpoints.

| Status | `error.code` | Meaning |
|---|---|---|
| `200` | | The shipment is known. |
| `400` | `VALIDATION_ERROR` | `shipmentId` is not a UUID. |
| `404` | `NOT_FOUND` | The shipment is not known: no `shipment.registered` has been processed for it, even if scans exist. |
| `503` | `DEPENDENCY_UNAVAILABLE` | The database is unavailable. Retry later. |
| `500` | `INTERNAL_ERROR` | Unexpected error. Retry later. |

The error body has the same shape as in the [Shipment API](shipment-api.md#error-body).

## Health

Readiness follows [ADR-0012](adr/0012-readiness-reflects-request-path.md): the service is ready
when it can answer its HTTP requests, which need only the database. NATS is reported for
information.

| Endpoint | `200` | `503` |
|---|---|---|
| `GET /health/live` | The process is running: `{ "status": "ok" }`. | |
| `GET /health/ready` | A database query works: `{ "status": "ready", "checks": { "database": "ok", "nats": "ok" } }`. With NATS disconnected still `200`, with `"nats": "failed"`; reads work, but new events are not processed. | The database is unavailable: `"status": "not_ready"` and `"database": "failed"`. |

## Configuration

| Variable | Default | |
|---|---|---|
| `TRACKING_DATABASE_URL` | (required) | Runtime role `tracking_service` (data only). |
| `TRACKING_MIGRATIONS_DATABASE_URL` | (required for migrations) | Used only by `pnpm db:migrate`, role `tracking_owner` ([ADR-0008](adr/0008-database-access-and-migrations.md)). |
| `TRACKING_OWNER_PASSWORD`, `TRACKING_SERVICE_PASSWORD` | (required by compose) | Passwords of the two roles; they must match the URLs. Read only when [`02-tracking.sh`](../infra/postgres/init/02-tracking.sh) creates the roles; its header says how to run it on an existing volume. |
| `TRACKING_PORT` | `3003` | Service-specific, because every service loads the same `.env`. |
| `HOST` | `127.0.0.1` | Shared with the other services. |
| `NATS_URL` | `nats://localhost:4222` | Shared with the other services. |

Local start: `pnpm db:migrate` and `pnpm nats:setup`, then `pnpm dev:tracking`.

At startup the service fails fast if the configuration is invalid, a migration is pending
("Run pnpm db:migrate first."), NATS is unreachable or the stream or the `tracking` consumer is
missing ("Run `pnpm nats:setup` first."). On `SIGINT` or `SIGTERM` it first stops consuming and
lets the message in progress finish, then closes HTTP, NATS and the database connections.

## Log

One structured line per processed message: `service`, `eventId`, `eventType`, `shipmentId`,
`correlationId`, `streamSequence` and `result`.

| `result` | Meaning |
|---|---|
| `processed` | A new event of a known shipment; the read model was updated. |
| `waiting_for_registration` | A new event of a shipment that is not known yet; it was only stored. |
| `duplicate` | An equal copy of a stored event, or a redelivery. |
| `conflict` | A different copy of a stored event; of the two, the copy with the higher stream sequence does not count (logged as a warning). |

## Simplifications (MVP)

- Lookup by `shipmentId` only; no lookup by `trackingNumber`.
- No authentication: anyone who knows a `shipmentId` can read its tracking.
- One instance: messages are processed one at a time by a single instance
  ([ADR-0014](adr/0014-tracking-stores-every-message.md)).
