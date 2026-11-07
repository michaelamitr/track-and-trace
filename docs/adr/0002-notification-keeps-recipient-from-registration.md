# ADR-0002: Notification keeps the recipient from the registration

Status: Accepted (recorded 2026-11-07)

## Context

Notification needs `recipientId` for `parcel.delivered` and `sla.breached`; only Shipment knows it.
Scan Ingestion produces `parcel.delivered` from scanner data (`shipmentId`, `facilityId`,
`scannerId`), has no database and must keep accepting scans when other services are down.

## Decision

Notification subscribes to `shipment.registered` and stores `shipmentId -> recipientId`
(Event-Carried State Transfer).

## Consequences

- Positive: no runtime dependency on Shipment.
- Negative: `recipientId` is stored twice.
- Negative: a delivered or breach event may arrive before the registration, so Notification must
  hold it until the registration arrives (lesson 3.2).

## Rejected alternatives

- `recipientId` in `parcel.delivered`: Scan Ingestion would have to call Shipment synchronously
  (scans stop when Shipment is down) or keep its own copy of registrations (state it does not need).
- Notification calls Shipment over HTTP per notification: the same temporal coupling, moved to
  Notification.
- `recipientId` encoded in the parcel barcode: the label is a snapshot printed at registration and
  cannot be updated, it would create a second source of truth, and scanners would carry recipient
  data they do not need. The barcode carries only the shipment identifier.
