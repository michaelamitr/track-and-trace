-- Up Migration
-- The read model of every known shipment (ADR-0014), computed from received_messages.
CREATE TABLE shipment_tracking (
  shipment_id     uuid        PRIMARY KEY,
  tracking_number text        NOT NULL,
  status          text        NOT NULL
                              CHECK (status IN ('REGISTERED', 'ACCEPTED', 'AT_HUB',
                                                'OUT_FOR_DELIVERY', 'DELIVERED')),
  last_location   text        NULL,
  last_event_at   timestamptz NOT NULL,
  delivered_at    timestamptz NULL,
  -- Processing time: when Tracking last processed a message for the shipment.
  updated_at      timestamptz NOT NULL,
  CHECK ((status = 'REGISTERED') = (last_location IS NULL)),
  CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL))
);

-- The ordered history; `position` follows R2 and starts at 1 for each shipment.
CREATE TABLE tracking_history (
  shipment_id uuid        NOT NULL REFERENCES shipment_tracking,
  position    integer     NOT NULL CHECK (position >= 1),
  event_id    uuid        NOT NULL UNIQUE,
  event_type  text        NOT NULL,
  status      text        NOT NULL
                          CHECK (status IN ('REGISTERED', 'ACCEPTED', 'AT_HUB',
                                            'OUT_FOR_DELIVERY', 'DELIVERED')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  facility_id text        NULL,
  is_anomaly  boolean     NOT NULL,
  PRIMARY KEY (shipment_id, position)
);

-- Copies that differ from the kept copy of their event. A conflict between two
-- shipments has a row under both, if both are known.
CREATE TABLE tracking_conflicts (
  shipment_id      uuid        NOT NULL REFERENCES shipment_tracking,
  event_id         uuid        NOT NULL,
  -- Both of the conflicting copy.
  stream_sequence  bigint      NOT NULL REFERENCES received_messages,
  received_at      timestamptz NOT NULL,
  differing_fields text[]      NOT NULL CHECK (cardinality(differing_fields) > 0),
  PRIMARY KEY (shipment_id, stream_sequence)
);

-- Down Migration
DROP TABLE tracking_conflicts;
DROP TABLE tracking_history;
DROP TABLE shipment_tracking;
