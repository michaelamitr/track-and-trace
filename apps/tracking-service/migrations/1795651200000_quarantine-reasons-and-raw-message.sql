-- Up Migration
-- The quarantine of ADR-0015: messages that are not a valid event (INVALID) and
-- valid events whose processing failed on the 5th or a later delivery
-- (PROCESSING_FAILED). The raw message is stored as bytes, so the write cannot
-- fail because of its content. Nothing wrote to the table before, so its
-- columns are replaced instead of converted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM quarantined_events) THEN
    RAISE EXCEPTION 'quarantined_events is not empty; this migration expects the empty table of 1795447896000';
  END IF;
END
$$;

ALTER TABLE quarantined_events
  DROP CONSTRAINT quarantined_events_reason_check,
  ADD CONSTRAINT quarantined_events_reason_check CHECK (reason IN ('INVALID', 'PROCESSING_FAILED')),
  ADD CONSTRAINT quarantined_events_stream_sequence_check CHECK (stream_sequence > 0),
  DROP COLUMN payload,
  ADD COLUMN raw_message bytea NOT NULL,
  -- What was wrong (INVALID) or the error text (PROCESSING_FAILED).
  ALTER COLUMN details TYPE text USING details::text;

-- GET /quarantine lists the newest first.
CREATE INDEX quarantined_events_detected_at_idx ON quarantined_events (detected_at DESC, id DESC);

-- Down Migration
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM quarantined_events) THEN
    RAISE EXCEPTION 'quarantined_events is not empty; its rows cannot be converted back';
  END IF;
END
$$;

DROP INDEX quarantined_events_detected_at_idx;

ALTER TABLE quarantined_events
  DROP CONSTRAINT quarantined_events_reason_check,
  ADD CONSTRAINT quarantined_events_reason_check CHECK (reason IN ('INVALID')),
  DROP CONSTRAINT quarantined_events_stream_sequence_check,
  DROP COLUMN raw_message,
  ADD COLUMN payload jsonb NOT NULL,
  ALTER COLUMN details TYPE jsonb USING details::jsonb;
