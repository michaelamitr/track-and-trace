# Event Catalog

All business events in Track & Trace. The source of truth is the code in
[`packages/contracts`](packages/contracts/src); this document describes it for humans.

## Transport

| Item | Value |
|---|---|
| Broker | NATS JetStream |
| Stream | `LOGISTICS_EVENTS` |
| Stream subjects | `logistics.>` |
| Subject format | `logistics.<entity>.<event>.v<version>` |
| Delivery guarantee | at-least-once |

Consumers must therefore assume that:

- the same event can be delivered more than once → processing is idempotent by `eventId`,
- events can arrive in a different order than they happened → business order is determined by `occurredAt`, not by arrival.

## Envelope

Every event shares the same envelope. Event-specific content is in `data`.

| Field | Type | Description |
|---|---|---|
| `eventId` | UUID | Unique ID of the logical event. Assigned by the producer (for scans by the scanner). A retry of the same event keeps the same `eventId`. |
| `eventType` | string | What happened, e.g. `parcel.delivered`. Duplicated from the subject so that a stored event is self-describing. |
| `eventVersion` | integer | Version of the `data` schema. Currently `1` for all events. |
| `shipmentId` | UUID | The shipment the event belongs to. |
| `occurredAt` | ISO 8601, UTC | When the event happened in the real world. |
| `receivedAt` | ISO 8601, UTC | When the system accepted the event. |
| `correlationId` | UUID | Links all events of one business process. |
| `causationId` | UUID \| null | `eventId` of the event that directly caused this one, otherwise `null`. |
| `producer` | string | Service that produced the event. |
| `data` | object | Event-specific payload, see below. |

All times must be UTC with the `Z` suffix (e.g. `2026-10-28T09:30:00Z`). Offsets such as `+01:00` are rejected.

## Events

### `shipment.registered`

| | |
|---|---|
| Subject | `logistics.shipment.registered.v1` |
| Producer | `shipment` |
| Consumers | Tracking (creates the tracking record), SLA Monitoring (stores the deadline), Notification (stores the recipient) |

| Field | Type | Description |
|---|---|---|
| `trackingNumber` | string | Public tracking number. |
| `originFacilityId` | string | Facility where the shipment starts. |
| `destination` | string | Destination of the shipment. |
| `recipientId` | string | Recipient identifier, used for notifications. |
| `expectedDeliveryAt` | ISO 8601, UTC | Promised delivery time (SLA). |

The registration time is the envelope's `occurredAt`.

```json
{
  "eventId": "5b3f7d0e-2c1a-4e8b-9f6d-3a2b1c0d9e8f",
  "eventType": "shipment.registered",
  "eventVersion": 1,
  "shipmentId": "0d40c8bb-e48f-4311-9223-1a54a7e197e4",
  "occurredAt": "2026-10-28T08:00:00Z",
  "receivedAt": "2026-10-28T08:00:00Z",
  "correlationId": "a1e8c78c-931b-4d11-a88f-38a26d4d8e17",
  "causationId": null,
  "producer": "shipment",
  "data": {
    "trackingNumber": "PF-0001",
    "originFacilityId": "DEPOT-PRAHA",
    "destination": "Brno",
    "recipientId": "CUST-42",
    "expectedDeliveryAt": "2026-10-29T16:00:00Z"
  }
}
```

### Scan events

Four events produced from warehouse and courier scans. They share the same payload.

| Event | Subject | Consumers |
|---|---|---|
| `parcel.accepted` | `logistics.parcel.accepted.v1` | Tracking |
| `parcel.arrived_at_hub` | `logistics.parcel.arrived_at_hub.v1` | Tracking |
| `parcel.out_for_delivery` | `logistics.parcel.out_for_delivery.v1` | Tracking |
| `parcel.delivered` | `logistics.parcel.delivered.v1` | Tracking, SLA Monitoring, Notification |

Producer: `scan-ingestion`.

| Field | Type | Description |
|---|---|---|
| `facilityId` | string | Facility where the scan happened. |
| `scannerId` | string | Scanner that produced the scan. |

```json
{
  "eventId": "4d36957b-6c2b-47e0-b784-13a9b00c0b67",
  "eventType": "parcel.arrived_at_hub",
  "eventVersion": 1,
  "shipmentId": "0d40c8bb-e48f-4311-9223-1a54a7e197e4",
  "occurredAt": "2026-10-28T09:30:00Z",
  "receivedAt": "2026-10-28T09:31:12Z",
  "correlationId": "a1e8c78c-931b-4d11-a88f-38a26d4d8e17",
  "causationId": null,
  "producer": "scan-ingestion",
  "data": {
    "facilityId": "DEPOT-BRNO",
    "scannerId": "SCANNER-17"
  }
}
```

### `sla.breached`

| | |
|---|---|
| Subject | `logistics.sla.breached.v1` |
| Producer | `sla-monitoring` |
| Consumers | Notification |

| Field | Type | Description |
|---|---|---|
| `incidentId` | UUID | SLA incident. At most one incident per shipment. |
| `expectedDeliveryAt` | ISO 8601, UTC | Promised delivery time. |
| `effectiveDeadline` | ISO 8601, UTC | `expectedDeliveryAt + SLA_GRACE_PERIOD`. |
| `reason` | `NOT_DELIVERED_IN_TIME` \| `DELIVERED_LATE` | Why the SLA was breached. |
| `deliveredAt` | ISO 8601, UTC \| null | Delivery time if the shipment was delivered late, otherwise `null`. |

```json
{
  "eventId": "e3b0c442-98fc-4c14-9afb-f4c8996fb924",
  "eventType": "sla.breached",
  "eventVersion": 1,
  "shipmentId": "0d40c8bb-e48f-4311-9223-1a54a7e197e4",
  "occurredAt": "2026-10-29T18:00:00Z",
  "receivedAt": "2026-10-29T18:00:00Z",
  "correlationId": "a1e8c78c-931b-4d11-a88f-38a26d4d8e17",
  "causationId": "5b3f7d0e-2c1a-4e8b-9f6d-3a2b1c0d9e8f",
  "producer": "sla-monitoring",
  "data": {
    "incidentId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "expectedDeliveryAt": "2026-10-29T16:00:00Z",
    "effectiveDeadline": "2026-10-29T18:00:00Z",
    "reason": "NOT_DELIVERED_IN_TIME",
    "deliveredAt": null
  }
}
```

## Versioning

- The version is part of both the subject (`.v1`) and the envelope (`eventVersion`).
- Published events are immutable. Corrections are new, explicit events.
- A change that alters the meaning or shape of `data` creates a new version (`.v2`) with its own schema. Consumers keep accepting older versions.