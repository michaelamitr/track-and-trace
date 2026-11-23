-- Up Migration
-- Invalid messages (ADR-0014). Nothing writes to it until lesson 3.4. event_id
-- and shipment_id are nullable: an invalid message may have none.
CREATE TABLE quarantined_events (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reason          text        NOT NULL CHECK (reason IN ('INVALID')),
  event_id        uuid        NULL,
  shipment_id     uuid        NULL,
  subject         text        NOT NULL,
  stream_sequence bigint      NOT NULL UNIQUE,
  payload         jsonb       NOT NULL,
  details         jsonb       NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE quarantined_events;
