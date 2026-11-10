# Shipment API

The HTTP contract of the Shipment Service
([`apps/shipment-service`](../apps/shipment-service/src)). The decision behind repeated requests
is [ADR-0007](adr/0007-idempotent-shipment-registration.md), publishing is
[ADR-0009](adr/0009-transactional-outbox.md). The event is described in
[EVENTS.md](../EVENTS.md).

Run it with `pnpm infra:up`, `pnpm nats:setup`, `pnpm db:migrate` and `pnpm dev:shipment`
(default `http://127.0.0.1:3001`). The OpenAPI document and Swagger UI are served at `/docs`
(JSON at `/docs/json`).

## POST /shipments

Registers a shipment. `shipment.registered` is published asynchronously (see
[Publishing](#publishing)).

Request body (JSON), all fields required:

| Field | Type | Rule |
|---|---|---|
| `orderReference` | string | 1–64 characters, the e-shop's own order number. Unique. |
| `originFacilityId` | string | Not empty. |
| `destination` | string | Not empty. |
| `recipientId` | string | Not empty. |
| `expectedDeliveryAt` | string | ISO 8601 UTC with the `Z` suffix, same rule as in [EVENTS.md](../EVENTS.md). |

Created by the service:

- `shipmentId` – UUID
- `trackingNumber` – `"PF-"` + 10 random digits, unique
- `eventId` of the `shipment.registered` event – stored with the shipment
- registration time – the event's `occurredAt` (and `receivedAt`)

Request:

```json
{
  "orderReference": "ESHOP-2026-004211",
  "originFacilityId": "PRG-HUB-01",
  "destination": "Brno",
  "recipientId": "cust-88231",
  "expectedDeliveryAt": "2026-11-11T16:00:00Z"
}
```

Response body for `201` and `200`:

```json
{
  "shipmentId": "0d40c8bb-e48f-4311-9223-1a54a7e197e4",
  "trackingNumber": "PF-4821093375",
  "orderReference": "ESHOP-2026-004211",
  "originFacilityId": "PRG-HUB-01",
  "destination": "Brno",
  "recipientId": "cust-88231",
  "expectedDeliveryAt": "2026-11-11T16:00:00Z"
}
```

### Status codes

| Status | `error.code` | Meaning | What the e-shop should do |
|---|---|---|---|
| `201` | | Created; the event will be published. | Store `shipmentId` and `trackingNumber`. |
| `200` | | The same request again; returns the existing shipment. | Treat it like `201`. |
| `400` | `VALIDATION_ERROR` | Invalid body. | Fix the request; do not retry it unchanged. |
| `409` | `ORDER_CONFLICT` | The same `orderReference` with different data. | Do not retry; check the order data. |
| `503` | `DEPENDENCY_UNAVAILABLE` | The database is unavailable; nothing was saved. | Retry the same request later. |
| `500` | `INTERNAL_ERROR` | Unexpected error. | Retry the same request later. |

A NATS outage does not fail the request: the event waits in the outbox.

### Repeated requests

- **Lost response.** The e-shop retries and gets `200` with the same `shipmentId` and
  `trackingNumber`. Nothing is published again; the outbox row written by the first request
  guarantees publication.
- **Same `orderReference`, different data.** `409`, nothing is changed or published. All request
  fields are compared; `expectedDeliveryAt` is compared as an instant, so
  `2026-11-11T16:00:00Z` and `2026-11-11T16:00:00.000Z` are the same data.
- **Two identical requests at the same time.** The unique constraint on `orderReference` lets only
  one insert win (`201`); the other waits for it and returns the existing shipment (`200`).

## GET /shipments/:shipmentId

Returns the stored shipment with the same body as above. `404` (`NOT_FOUND`) if it does not
exist, `400` (`VALIDATION_ERROR`) if `shipmentId` is not a UUID, `503` if the database is
unavailable.

## Error body

Every error response has the same shape. `details` is present only for validation errors and
lists the failing fields; `500` never contains internal details (they are logged).

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is invalid.",
    "details": [
      { "path": "body.expectedDeliveryAt", "message": "Invalid ISO datetime" }
    ]
  }
}
```

## Health

| Endpoint | `200` | `503` |
|---|---|---|
| `GET /health/live` | The process is up: `{ "status": "ok" }`. | |
| `GET /health/ready` | A database query works and NATS is connected: `{ "status": "ready", "checks": { "database": "ok", "nats": "ok" } }`. | A dependency is down: `"status": "not_ready"` and the failed check is `"failed"`. |

## Publishing

`shipment.registered` is published through a transactional outbox
([ADR-0009](adr/0009-transactional-outbox.md)):

1. The request inserts the shipment and an `outbox` row with the complete event in **one**
   transaction, so either both are saved or neither.
2. The outbox relay inside the service polls the table about every second, publishes unpublished
   rows to NATS (`Nats-Msg-Id` = `eventId`), waits for the ack and sets `published_at`. When NATS
   is down it retries with backoff; the event is published once NATS is back (AC-06).

Delivery is at-least-once: a copy published twice is dropped by `Nats-Msg-Id` within the stream's
duplicate window and by the consumers' inbox. Every event of a shipment has
`correlationId` = `shipmentId`.

## Configuration

| Variable | Default | |
|---|---|---|
| `SHIPMENT_DATABASE_URL` | (required) | Runtime role `shipment_service`. |
| `NATS_URL` | `nats://localhost:4222` | |
| `PORT` | `3001` | |
| `HOST` | `127.0.0.1` | |

At startup the service fails fast if the configuration is invalid, a migration is pending
("Run pnpm db:migrate first."), NATS is unreachable or the stream is missing.

## Simplifications (MVP)

Deliberate, because the project is about architecture, not carrier business logic:

- `expectedDeliveryAt` is sent by the e-shop; carrier service levels and transit-time calculation
  are out of scope.
- One order = one shipment. Multi-parcel orders would need `orderReference` + parcel number.
- A single e-shop. Several e-shops would need an e-shop id + `orderReference`.
- `trackingNumber` has no check digit.
- No live delivery estimate (ETA); `expectedDeliveryAt` is a promise, not an estimate.
