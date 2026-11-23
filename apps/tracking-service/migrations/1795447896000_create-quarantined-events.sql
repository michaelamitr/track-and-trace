-- Up Migration
-- A general quarantine (ADR-0011). Only CONFLICT for now; INVALID comes in
-- lesson 3.4, therefore event_id and shipment_id are nullable.
CREATE TABLE quarantined_events (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reason          text        NOT NULL CHECK (reason IN ('CONFLICT')),
  event_id        uuid        NULL,
  -- For CONFLICT: the shipment of the kept copy; the quarantined copy has its own in payload.
  shipment_id     uuid        NULL,
  subject         text        NOT NULL,
  -- A redelivery is the same message, so it is quarantined once.
  stream_sequence bigint      NOT NULL UNIQUE,
  payload         jsonb       NOT NULL,
  -- For CONFLICT: a JSON array with the names of the differing fields.
  details         jsonb       NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (reason <> 'CONFLICT'
         OR (event_id IS NOT NULL AND shipment_id IS NOT NULL AND jsonb_typeof(details) = 'array'))
);

-- GET /tracking/:shipmentId/anomalies finds a conflict by both shipments: the
-- one of the kept copy and the one in the quarantined copy. The second index
-- is on text, not uuid: the payload of a future INVALID row may hold anything.
CREATE INDEX quarantined_events_shipment_id_idx ON quarantined_events (shipment_id);
CREATE INDEX quarantined_events_payload_shipment_id_idx
  ON quarantined_events (lower(payload ->> 'shipmentId'));

-- Down Migration
DROP TABLE quarantined_events;
