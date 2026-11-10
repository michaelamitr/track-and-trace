import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from './migrations.js'
import { startPostgres, type TestPostgres } from './test-postgres.js'

// Postgres error codes (SQLSTATE).
const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514'
const INSUFFICIENT_PRIVILEGE = '42501'

let postgres: TestPostgres
let service: pg.Client

const quiet = () => {}

beforeAll(async () => {
  postgres = await startPostgres()
  await runMigrations({ databaseUrl: postgres.ownerUrl, direction: 'up', log: quiet })
  service = new pg.Client({ connectionString: postgres.serviceUrl })
  await service.connect()
})

afterAll(async () => {
  await service?.end()
  await postgres?.stop()
})

type ShipmentRow = {
  shipment_id: string
  order_reference: string
  tracking_number: string
  origin_facility_id: string
  destination: string
  recipient_id: string
  expected_delivery_at: string
  registered_at: string
  registered_event_id: string
}

let trackingSeq = 0

/** A valid row whose unique columns differ from every other row built here. */
function validRow(overrides: Partial<ShipmentRow> = {}): ShipmentRow {
  trackingSeq += 1
  return {
    shipment_id: randomUUID(),
    order_reference: `ORD-${randomUUID()}`,
    tracking_number: `PF-${String(trackingSeq).padStart(10, '0')}`,
    origin_facility_id: 'FAC-PRG-01',
    destination: 'Brno',
    recipient_id: 'RCP-0001',
    expected_delivery_at: '2026-11-12T12:00:00Z',
    registered_at: '2026-11-10T09:00:00Z',
    registered_event_id: randomUUID(),
    ...overrides,
  }
}

function insert(client: pg.Client, row: ShipmentRow) {
  return client.query(
    `INSERT INTO shipments (
       shipment_id, order_reference, tracking_number, origin_facility_id, destination,
       recipient_id, expected_delivery_at, registered_at, registered_event_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.shipment_id,
      row.order_reference,
      row.tracking_number,
      row.origin_facility_id,
      row.destination,
      row.recipient_id,
      row.expected_delivery_at,
      row.registered_at,
      row.registered_event_id,
    ],
  )
}

async function tableExists(table: 'shipments' | 'outbox'): Promise<boolean> {
  const result = await service.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${table}`],
  )
  return result.rows[0]?.exists ?? false
}

function insertOutbox(client: pg.Client, eventId: string = randomUUID()) {
  return client.query(`INSERT INTO outbox (event_id, subject, payload) VALUES ($1, $2, $3)`, [
    eventId,
    'logistics.shipment.registered.v1',
    JSON.stringify({ eventId }),
  ])
}

describe('as shipment_service after migrations up', () => {
  afterEach(async () => {
    await service.query('DELETE FROM shipments')
    await service.query('DELETE FROM outbox')
  })

  it('inserts a valid row', async () => {
    const row = validRow()
    await insert(service, row)

    const result = await service.query('SELECT order_reference FROM shipments WHERE shipment_id = $1', [
      row.shipment_id,
    ])
    expect(result.rows).toEqual([{ order_reference: row.order_reference }])
  })

  it.each(['order_reference', 'tracking_number', 'registered_event_id'] as const)(
    'rejects a second row with the same %s',
    async (column) => {
      const first = validRow()
      await insert(service, first)

      await expect(insert(service, validRow({ [column]: first[column] }))).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      })
    },
  )

  it('rejects a tracking_number that does not match PF- and ten digits', async () => {
    await expect(insert(service, validRow({ tracking_number: 'PF-123' }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    })
  })

  it('rejects an empty order_reference and one longer than 64 characters', async () => {
    await expect(insert(service, validRow({ order_reference: '' }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    })
    await expect(insert(service, validRow({ order_reference: 'x'.repeat(65) }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    })
  })

  it('cannot drop the shipments table', async () => {
    await expect(service.query('DROP TABLE shipments')).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    })
    expect(await tableExists('shipments')).toBe(true)
  })

  it('inserts an outbox row with created_at set and published_at null, and can mark it published', async () => {
    const eventId = randomUUID()
    await insertOutbox(service, eventId)

    const inserted = await service.query(
      'SELECT created_at IS NOT NULL AS has_created_at, published_at FROM outbox WHERE event_id = $1',
      [eventId],
    )
    expect(inserted.rows).toEqual([{ has_created_at: true, published_at: null }])

    await service.query('UPDATE outbox SET published_at = now() WHERE event_id = $1', [eventId])
    const updated = await service.query('SELECT published_at FROM outbox WHERE event_id = $1', [eventId])
    expect(updated.rows[0]?.published_at).toBeInstanceOf(Date)
  })

  it('rejects a second outbox row with the same event_id', async () => {
    const eventId = randomUUID()
    await insertOutbox(service, eventId)

    await expect(insertOutbox(service, eventId)).rejects.toMatchObject({ code: UNIQUE_VIOLATION })
  })

  it('has a partial index on created_at for unpublished rows', async () => {
    const result = await service.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'outbox' AND indexname = 'outbox_unpublished_created_at_idx'`,
    )
    expect(result.rows[0]?.indexdef).toMatch(/\(created_at\) WHERE \(published_at IS NULL\)/)
  })

  it('cannot drop the outbox table', async () => {
    await expect(service.query('DROP TABLE outbox')).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
    expect(await tableExists('outbox')).toBe(true)
  })
})

describe('migrations down and up again', () => {
  const down = () => runMigrations({ databaseUrl: postgres.ownerUrl, direction: 'down', log: quiet })

  it('down removes the tables in reverse order, up recreates them', async () => {
    expect((await down()).map((m) => m.name)).toEqual(['1794343443863_create-outbox'])
    expect(await tableExists('outbox')).toBe(false)
    expect(await tableExists('shipments')).toBe(true)

    expect((await down()).map((m) => m.name)).toEqual(['1794309982916_create-shipments'])
    expect(await tableExists('shipments')).toBe(false)

    const up = await runMigrations({ databaseUrl: postgres.ownerUrl, direction: 'up', log: quiet })
    expect(up.map((m) => m.name)).toEqual(['1794309982916_create-shipments', '1794343443863_create-outbox'])
    expect(await tableExists('shipments')).toBe(true)
    expect(await tableExists('outbox')).toBe(true)

    // The recreated tables are usable by shipment_service again (default privileges).
    await expect(insert(service, validRow())).resolves.toBeDefined()
    await expect(insertOutbox(service)).resolves.toBeDefined()
  })
})
