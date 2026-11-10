import type pg from 'pg'
import type { Shipment } from '../domain/shipment.js'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

type ShipmentRow = {
  shipment_id: string
  order_reference: string
  tracking_number: string
  origin_facility_id: string
  destination: string
  recipient_id: string
  expected_delivery_at: Date
  registered_at: Date
  registered_event_id: string
}

const COLUMNS = `shipment_id, order_reference, tracking_number, origin_facility_id, destination,
  recipient_id, expected_delivery_at, registered_at, registered_event_id`

/** Name of the unique constraint on tracking_number (Postgres default naming). */
export const TRACKING_NUMBER_CONSTRAINT = 'shipments_tracking_number_key'

function toShipment(row: ShipmentRow): Shipment {
  return {
    shipmentId: row.shipment_id,
    orderReference: row.order_reference,
    trackingNumber: row.tracking_number,
    originFacilityId: row.origin_facility_id,
    destination: row.destination,
    recipientId: row.recipient_id,
    expectedDeliveryAt: row.expected_delivery_at,
    registeredAt: row.registered_at,
    registeredEventId: row.registered_event_id,
  }
}

/**
 * Inserts the shipment unless one with the same order_reference exists.
 * Returns the inserted shipment, or null if the order_reference was taken.
 * If another transaction is inserting the same order_reference, Postgres waits
 * for it to finish first, so concurrent requests never both insert.
 */
export async function insertShipmentIfNew(db: Queryable, shipment: Shipment): Promise<Shipment | null> {
  const result = await db.query<ShipmentRow>(
    `INSERT INTO shipments (${COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (order_reference) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      shipment.shipmentId,
      shipment.orderReference,
      shipment.trackingNumber,
      shipment.originFacilityId,
      shipment.destination,
      shipment.recipientId,
      shipment.expectedDeliveryAt,
      shipment.registeredAt,
      shipment.registeredEventId,
    ],
  )
  const row = result.rows[0]
  return row ? toShipment(row) : null
}

export async function findShipmentByOrderReference(
  db: Queryable,
  orderReference: string,
): Promise<Shipment | null> {
  const result = await db.query<ShipmentRow>(
    `SELECT ${COLUMNS} FROM shipments WHERE order_reference = $1`,
    [orderReference],
  )
  const row = result.rows[0]
  return row ? toShipment(row) : null
}

export async function findShipmentById(db: Queryable, shipmentId: string): Promise<Shipment | null> {
  const result = await db.query<ShipmentRow>(`SELECT ${COLUMNS} FROM shipments WHERE shipment_id = $1`, [
    shipmentId,
  ])
  const row = result.rows[0]
  return row ? toShipment(row) : null
}
