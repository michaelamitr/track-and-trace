# Scan Ingestion API

The HTTP contract of the Scan Ingestion Service
([`apps/scan-ingestion-service`](../apps/scan-ingestion-service/src)). Publishing is decided in
[ADR-0010](adr/0010-scan-ingestion-publishing.md). The events are described in
[EVENTS.md](../EVENTS.md).

Run it with `pnpm infra:up`, `pnpm nats:setup` and `pnpm dev:scan-ingestion` (default
`http://127.0.0.1:3002`). The OpenAPI document and Swagger UI are served at `/docs` (JSON at
`/docs/json`).

## POST /scans

Accepts one scan from a warehouse or courier scanner and publishes it as a `parcel.*` event.
`202` is returned only after JetStream has confirmed the publish.

Request body (JSON), all fields required:

| Field | Type | Rule |
|---|---|---|
| `eventId` | string | UUID, assigned by the scanner. A retried scan must reuse it. |
| `shipmentId` | string | UUID. |
| `type` | string | One of `ACCEPTED`, `ARRIVED_AT_HUB`, `OUT_FOR_DELIVERY`, `DELIVERED`. |
| `occurredAt` | string | ISO 8601 UTC with the `Z` suffix, same rule as in [EVENTS.md](../EVENTS.md). At most 5 minutes in the future (tolerance for scanner clock skew); any past time is accepted (scans sent after a connection outage). |
| `facilityId` | string | 1–64 characters. |
| `scannerId` | string | 1–64 characters. |

### Scan type → event

| `type` | Event |
|---|---|
| `ACCEPTED` | `parcel.accepted` |
| `ARRIVED_AT_HUB` | `parcel.arrived_at_hub` |
| `OUT_FOR_DELIVERY` | `parcel.out_for_delivery` |
| `DELIVERED` | `parcel.delivered` |

Scanners never send internal event type names; any other `type` is `400`.

### Normalization

`eventId` and `shipmentId` are converted to lowercase before anything else, so the same UUID in a
different letter case never becomes two events or two shipments. The response and the event
contain only the lowercase values.

### Set by the service

- `eventType` – from the mapping above; `eventVersion` – `1`
- `receivedAt` – server time when the request arrived
- `correlationId` – `shipmentId`; `causationId` – `null`
- `producer` – `"scan-ingestion"`
- subject – `subjectForEvent` (e.g. `logistics.parcel.arrived_at_hub.v1`)

Request:

```json
{
  "eventId": "4D36957B-6C2B-47E0-B784-13A9B00C0B67",
  "shipmentId": "0d40c8bb-e48f-4311-9223-1a54a7e197e4",
  "type": "ARRIVED_AT_HUB",
  "occurredAt": "2026-10-28T09:30:00Z",
  "facilityId": "DEPOT-BRNO",
  "scannerId": "SCANNER-17"
}
```

Response body for `202`:

```json
{
  "eventId": "4d36957b-6c2b-47e0-b784-13a9b00c0b67"
}
```

Published event (subject `logistics.parcel.arrived_at_hub.v1`):

```json
{
  "eventId": "4d36957b-6c2b-47e0-b784-13a9b00c0b67",
  "eventType": "parcel.arrived_at_hub",
  "eventVersion": 1,
  "shipmentId": "0d40c8bb-e48f-4311-9223-1a54a7e197e4",
  "occurredAt": "2026-10-28T09:30:00Z",
  "receivedAt": "2026-10-28T09:31:12Z",
  "correlationId": "0d40c8bb-e48f-4311-9223-1a54a7e197e4",
  "causationId": null,
  "producer": "scan-ingestion",
  "data": {
    "facilityId": "DEPOT-BRNO",
    "scannerId": "SCANNER-17"
  }
}
```

The event is published without `Nats-Msg-Id`, so JetStream does not drop copies with the same
`eventId` ([ADR-0010](adr/0010-scan-ingestion-publishing.md)).

### Status codes

| Status | `error.code` | When | Retry safe? |
|---|---|---|---|
| `202` | | JetStream confirmed the publish. | |
| `400` | `VALIDATION_ERROR` | Invalid body, including an unknown `type` and `occurredAt` more than 5 minutes in the future. | No; fix the scan, do not retry it unchanged. |
| `503` | `DEPENDENCY_UNAVAILABLE` | NATS did not confirm the publish: not connected, or the publish timed out (NATS client default timeout). | Yes, with the same `eventId`. |
| `500` | `INTERNAL_ERROR` | Unexpected error. | Yes, with the same `eventId`. |

The error body has the same shape as in the [Shipment API](shipment-api.md#error-body).

### Why there is no 404 and no 409

- **No `404`.** The service does not check whether the shipment exists. A scan can arrive before
  the registration; it is published anyway and handled downstream (AC-11).
- **No `409`.** The service keeps no state, so it cannot see that an `eventId` was already used
  with different content. Tracking records such conflicting copies in `tracking_conflicts` and
  does not project them ([ADR-0014](adr/0014-tracking-stores-every-message.md), AC-12).

### Retries

On `503`, `500` or a timeout the scanner retries the same scan with the same `eventId` (AC-07):

- **NATS is down.** The service answers `503`. Usually nothing is stored, but the NATS client
  may still send the buffered publish after it reconnects; that copy is then handled like the
  next case. The retry succeeds once NATS is back.
- **Stored, but the response was lost** (including a publish that timed out after the stream had
  stored it). The retry stores a second copy with the same `eventId` and a later `receivedAt`.
  Consumers deduplicate by `eventId` and keep the earliest `receivedAt`
  ([R1](tracking-projection.md#projection-rules), [ADR-0004](adr/0004-deterministic-tracking-projection.md)).
- **Retry of an identical scan after `202`.** Also stores a second copy; also safe, for the same
  reason.

Copies differ only in `receivedAt`, so they are duplicates, not conflicts
([ADR-0005](adr/0005-quarantine-conflicting-events.md)).

## Health

| Endpoint | `200` | `503` |
|---|---|---|
| `GET /health/live` | The process is running: `{ "status": "ok" }`. | |
| `GET /health/ready` | NATS is connected: `{ "status": "ready", "checks": { "nats": "ok" } }`. | NATS is not connected: `"status": "not_ready"` and `"nats": "failed"`. |

## Configuration

| Variable | Default | |
|---|---|---|
| `SCAN_INGESTION_PORT` | `3002` | Service-specific, because every service loads the same `.env`. |
| `HOST` | `127.0.0.1` | Shared with the other services. |
| `NATS_URL` | `nats://localhost:4222` | Shared with the other services. |

At startup the service fails fast if the configuration is invalid, NATS is unreachable or the
stream is missing ("Run `pnpm nats:setup` first.").

## Simplifications (MVP)

- Scanners are not authenticated.
- The 5-minute clock tolerance for `occurredAt` is a fixed constant, not configurable.
