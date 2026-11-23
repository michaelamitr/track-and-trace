-- Up Migration
-- Every received event once (ADR-0011); also the inbox. `payload` is the whole
-- event, the earliest received of the equal copies (R1). Of different copies the
-- one with the lowest stream_sequence is kept, whatever the processing order.
CREATE TABLE tracking_events (
  event_id        uuid        PRIMARY KEY,
  shipment_id     uuid        NOT NULL,
  event_type      text        NOT NULL
                              CHECK (event_type IN ('shipment.registered', 'parcel.accepted',
                                                    'parcel.arrived_at_hub', 'parcel.out_for_delivery',
                                                    'parcel.delivered')),
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL,
  payload         jsonb       NOT NULL,
  -- The message with the lowest stream sequence among the equal copies.
  subject         text        NOT NULL,
  stream_sequence bigint      NOT NULL CHECK (stream_sequence > 0)
);

-- Every message loads all events of its shipment.
CREATE INDEX tracking_events_shipment_id_idx ON tracking_events (shipment_id);

-- Down Migration
DROP TABLE tracking_events;
