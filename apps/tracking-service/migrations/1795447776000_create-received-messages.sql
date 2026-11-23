-- Up Migration
-- Every message of the stream that Tracking received, exactly as it came
-- (ADR-0014); also the inbox. Rows are only inserted, never updated or moved:
-- which copy of an event counts is decided by resolveCopies() on every read.
CREATE TABLE received_messages (
  -- A redelivery is the same message with the same stream sequence.
  stream_sequence bigint      PRIMARY KEY CHECK (stream_sequence > 0),
  event_id        uuid        NOT NULL,
  shipment_id     uuid        NOT NULL,
  subject         text        NOT NULL,
  event_type      text        NOT NULL
                              CHECK (event_type IN ('shipment.registered', 'parcel.accepted',
                                                    'parcel.arrived_at_hub', 'parcel.out_for_delivery',
                                                    'parcel.delivered')),
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL,
  payload         jsonb       NOT NULL
);

CREATE INDEX received_messages_event_id_idx ON received_messages (event_id);
CREATE INDEX received_messages_shipment_id_idx ON received_messages (shipment_id);

-- Down Migration
DROP TABLE received_messages;
