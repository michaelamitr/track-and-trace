-- Up Migration
-- Transactional outbox (ADR-0009): a row is written in the same transaction as
-- the shipment and published to NATS by the outbox relay. `payload` is the
-- complete event envelope. Published rows are kept (published_at is set).
CREATE TABLE outbox (
  event_id     uuid        PRIMARY KEY,
  subject      text        NOT NULL,
  payload      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL
);

-- The relay only reads unpublished rows, oldest first.
CREATE INDEX outbox_unpublished_created_at_idx ON outbox (created_at) WHERE published_at IS NULL;

-- Down Migration
DROP TABLE outbox;
