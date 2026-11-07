# Tracking Projection

How the Tracking service derives the current state of a shipment from its events. The logic is the
function `project()` in [`projection.ts`](../apps/tracking-service/src/domain/projection.ts). Its
tests in [`projection.test.ts`](../apps/tracking-service/src/domain/projection.test.ts) name the
rule they check. The events themselves are described in [`EVENTS.md`](../EVENTS.md).

Events are delivered at least once and can arrive out of order, so the result depends only on which
events exist, never on how many times or in what order they were delivered.

## Shipment statuses

| Status | Event type | What physically happened |
|---|---|---|
| `REGISTERED` | `shipment.registered` | The e-shop registered the shipment. The parcel is still with the sender. |
| `ACCEPTED` | `parcel.accepted` | The carrier took the parcel over for transport (not the recipient). |
| `AT_HUB` | `parcel.arrived_at_hub` | The parcel arrived at a distribution center. Can repeat. |
| `OUT_FOR_DELIVERY` | `parcel.out_for_delivery` | The parcel was loaded into the courier's vehicle for the last mile. |
| `DELIVERED` | `parcel.delivered` | The parcel was handed over to the recipient. Final state. |

## The three moments of a scan

| Moment | Meaning | Stored |
|---|---|---|
| `occurredAt` | The physical event: the time of the scan. | In the event |
| `receivedAt` | When Scan Ingestion accepted the scan. | In the event |
| Processing time | When Tracking processed the event. | No |

Only `occurredAt` drives the status. A scan that reaches the system late still happened at its
`occurredAt`.

Times are compared as parsed timestamps, never as strings. The contract accepts fractional seconds,
and as strings `09:30:00.500Z` sorts before `09:30:00Z`.

## Projection rules

- **R1** Copies with the same `eventId` are duplicates (a technical retry), not anomalies. They are
  counted once, and the copy with the earliest `receivedAt` is kept. If two copies have the same
  `receivedAt` instant (equal `Date.parse`, e.g. `08:01:00Z` and `08:01:00.000Z`), the one whose
  `receivedAt` string is code-unit smaller (`a < b`) is kept. This is only a tie-breaker: which
  instant is earlier is still decided by `Date.parse`.
- **R2** Events are ordered by `occurredAt`, then by lifecycle phase (`REGISTERED` < `ACCEPTED` <
  `AT_HUB` < `OUT_FOR_DELIVERY` < `DELIVERED`), then by `eventId` as a stable tie-breaker. Never by
  arrival order. The `eventId` tie-breaker uses plain code-unit comparison (`a < b`), not
  `localeCompare`, so the order cannot depend on the machine's locale.
- **R3** Before delivery, the last event in the ordered history determines the status. Returning
  from `OUT_FOR_DELIVERY` to `AT_HUB` is valid (failed delivery attempt).
- **R4** The first `DELIVERED` in the ordered history is the final state. Its `occurredAt` is the
  delivery time.
- **R5** Every event ordered after the first `DELIVERED` is an anomaly: it stays in the history but
  does not change the status.
- **R6** Events ordered before the delivery are normal history even if they arrived late.

### Out of scope: conflicting copies

Copies with the same `eventId` may differ only in `receivedAt`. Any other difference, in the
envelope or the payload (including `scannerId`), is a conflict ([AC-12](acceptance-scenarios.md)).
A conflict is quarantined before the projection and is out of scope for `project()`.

## Output of `project()`

"The event that determined the status" is the last event in the ordered history (R3) or, once the
shipment is delivered, the first `DELIVERED` (R4).

| Field | Type | Meaning |
|---|---|---|
| `status` | `ShipmentStatus` \| `null` | Current status. `null` when there are no events. |
| `lastLocation` | string \| `null` | `facilityId` of the event that determined the status. `null` for `shipment.registered`, which has no `facilityId`, and when there are no events. |
| `lastEventAt` | ISO 8601, UTC \| `null` | `occurredAt` of the event that determined the status. `null` when there are no events. |
| `deliveredAt` | ISO 8601, UTC \| `null` | `occurredAt` of the first `DELIVERED`. `null` before delivery. |
| `history` | `HistoryEntry[]` | Every unique event in the order given by R2, including anomalies. |

Each `HistoryEntry` contains:

| Field | Type | Meaning |
|---|---|---|
| `eventId` | UUID | ID of the event. |
| `eventType` | string | Type of the event. |
| `status` | `ShipmentStatus` | Status that the event type maps to, also for anomalies. |
| `occurredAt` | ISO 8601, UTC | When the event physically happened. |
| `receivedAt` | ISO 8601, UTC | When the system accepted the event. The earliest value if the event was retried (R1). |
| `facilityId` | string \| `null` | Facility of the scan. `null` for `shipment.registered`. |
| `isAnomaly` | boolean | `true` if the event is ordered after the first `DELIVERED` (R5). |
