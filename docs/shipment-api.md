# Shipment API (planned, lesson 2.2)

The HTTP contract of the Shipment Service. Nothing here is implemented yet. The decision behind
repeated requests is [ADR-0007](adr/0007-idempotent-shipment-registration.md). The event is
described in [EVENTS.md](../EVENTS.md).

## POST /shipments (planned, lesson 2.2)

Registers a shipment and publishes `shipment.registered`.

Request body (JSON), all fields required:

| Field | Type | Rule |
|---|---|---|
| `orderReference` | string | 1–64 characters, the e-shop's own order number. Unique. |
| `originFacilityId` | string | |
| `destination` | string | |
| `recipientId` | string | |
| `expectedDeliveryAt` | string | ISO 8601 UTC with the `Z` suffix, same rule as in [EVENTS.md](../EVENTS.md). |

Created by the service:

- `shipmentId` – UUID
- `trackingNumber` – `"PF-"` + 10 random digits, unique
- `eventId` of the `shipment.registered` event – stored with the shipment
- registration time – the event's `occurredAt`

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

| Status | Meaning | What the e-shop should do |
|---|---|---|
| `201` | Created and published. | Store `shipmentId` and `trackingNumber`. |
| `200` | The same request again; returns the existing shipment. | Treat it like `201`. |
| `400` | Invalid body. | Fix the request; do not retry it unchanged. |
| `409` | The same `orderReference` with different data. | Do not retry; check the order data. |
| `503` | Saved, but publishing the event failed. | Retry the same request later. |

### Repeated requests

- **Lost response.** The e-shop retries and gets `200`. The event is published again with the
  same `eventId`; the copy is dropped by `Nats-Msg-Id` or by the consumers' inbox.
- **Publishing failed.** The e-shop gets `503` and retries; the retry publishes the stored event.
- **Same `orderReference`, different data.** `409`, nothing is changed or published.
- **Two identical requests at the same time.** The unique constraint on `orderReference` lets only
  one insert win; the other behaves like a retry.

## GET /shipments/:shipmentId (planned, lesson 2.2)

Returns the stored shipment with the same body as above, or `404` if it does not exist.

## Known risk

Dual write: the shipment is saved before the event is published. A crash in between leaves a
shipment that no other service knows about until the e-shop retries. Solved properly by the
transactional outbox (lesson 3.3).

## Simplifications (MVP)

Deliberate, because the project is about architecture, not carrier business logic:

- `expectedDeliveryAt` is sent by the e-shop; carrier service levels and transit-time calculation
  are out of scope.
- One order = one shipment. Multi-parcel orders would need `orderReference` + parcel number.
- A single e-shop. Several e-shops would need an e-shop id + `orderReference`.
- `trackingNumber` has no check digit.
- No live delivery estimate (ETA); `expectedDeliveryAt` is a promise, not an estimate.
