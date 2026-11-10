-- Up Migration
CREATE TABLE shipments (
  shipment_id          uuid        PRIMARY KEY,
  order_reference      text        NOT NULL UNIQUE
                                   CHECK (char_length(order_reference) BETWEEN 1 AND 64),
  tracking_number      text        NOT NULL UNIQUE
                                   CHECK (tracking_number ~ '^PF-[0-9]{10}$'),
  origin_facility_id   text        NOT NULL,
  destination          text        NOT NULL,
  recipient_id         text        NOT NULL,
  expected_delivery_at timestamptz NOT NULL,
  registered_at        timestamptz NOT NULL,
  registered_event_id  uuid        NOT NULL UNIQUE
);

-- Down Migration
DROP TABLE shipments;
