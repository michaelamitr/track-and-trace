import { randomUUID } from 'node:crypto'
import { runMigrations } from '@tt/db'
import { startPostgres, type TestPostgres } from '@tt/db/testing'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR } from './migrations.js'

// Postgres error codes (SQLSTATE).
const NOT_NULL_VIOLATION = '23502'
const FOREIGN_KEY_VIOLATION = '23503'
const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514'
const INSUFFICIENT_PRIVILEGE = '42501'

const MIGRATIONS = [
  '1795447776000_create-tracking-events',
  '1795447836000_create-read-model',
  '1795447896000_create-quarantined-events',
]
const TABLES = ['quarantined_events', 'shipment_tracking', 'tracking_events', 'tracking_history']
const TIME = '2026-10-28T09:30:00Z'

let postgres: TestPostgres
let ownerUrl: string
let service: pg.Client

const run = (direction: 'up' | 'down') =>
  runMigrations({ databaseUrl: ownerUrl, dir: MIGRATIONS_DIR, direction, log: () => {} })

beforeAll(async () => {
  postgres = await startPostgres()
  ownerUrl = postgres.url('tracking_owner', 'tracking_db')
  await run('up')
  service = new pg.Client({ connectionString: postgres.url('tracking_service', 'tracking_db') })
  await service.connect()
})

afterAll(async () => {
  await service?.end()
  await postgres?.stop()
})

type Row = Record<string, unknown>

function insert(table: string, row: Row) {
  const columns = Object.keys(row)
  const placeholders = columns.map((_column, index) => `$${index + 1}`)
  return service.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    Object.values(row),
  )
}

function eventRow(overrides: Row = {}): Row {
  return {
    event_id: randomUUID(),
    shipment_id: randomUUID(),
    event_type: 'parcel.accepted',
    occurred_at: TIME,
    received_at: TIME,
    payload: '{}',
    subject: 'logistics.parcel.accepted.v1',
    stream_sequence: 1,
    ...overrides,
  }
}

function trackingRow(overrides: Row = {}): Row {
  return {
    shipment_id: randomUUID(),
    tracking_number: 'PF-4821093375',
    status: 'AT_HUB',
    last_location: 'DEPOT-BRNO',
    last_event_at: TIME,
    delivered_at: null,
    updated_at: TIME,
    ...overrides,
  }
}

function historyRow(overrides: Row = {}): Row {
  return {
    shipment_id: randomUUID(),
    position: 1,
    event_id: randomUUID(),
    event_type: 'parcel.accepted',
    status: 'ACCEPTED',
    occurred_at: TIME,
    received_at: TIME,
    facility_id: 'DEPOT-BRNO',
    is_anomaly: false,
    ...overrides,
  }
}

let sequence = 0
function quarantineRow(overrides: Row = {}): Row {
  sequence += 1
  return {
    reason: 'CONFLICT',
    event_id: randomUUID(),
    shipment_id: randomUUID(),
    subject: 'logistics.parcel.accepted.v1',
    stream_sequence: sequence,
    payload: '{}',
    details: '["data.facilityId"]',
    ...overrides,
  }
}

/** A known shipment with one stored event, so a history row can refer to both. */
async function knownShipment() {
  const shipmentId = randomUUID()
  const eventId = randomUUID()
  await insert('tracking_events', eventRow({ event_id: eventId, shipment_id: shipmentId }))
  await insert('shipment_tracking', trackingRow({ shipment_id: shipmentId }))
  return { shipment_id: shipmentId, event_id: eventId }
}

async function tables(): Promise<string[]> {
  const result = await service.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations' ORDER BY tablename`,
  )
  return result.rows.map((row) => row.tablename)
}

async function indexDefinition(name: string): Promise<string | undefined> {
  const result = await service.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [name])
  return result.rows[0]?.indexdef
}

describe('as tracking_service after migrations up', () => {
  afterEach(async () => {
    for (const table of ['tracking_history', 'shipment_tracking', 'tracking_events', 'quarantined_events']) {
      await service.query(`DELETE FROM ${table}`)
    }
  })

  it('has exactly the four tables of ADR-0011', async () => {
    expect(await tables()).toEqual(TABLES)
  })

  it.each(TABLES)('cannot drop %s', async (table) => {
    await expect(service.query(`DROP TABLE ${table}`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
    expect(await tables()).toContain(table)
  })

  describe('tracking_events', () => {
    it('stores an event_id once', async () => {
      const row = eventRow()
      await insert('tracking_events', row)

      await expect(insert('tracking_events', eventRow({ event_id: row.event_id }))).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      })
    })

    it.each([
      'shipment.registered',
      'parcel.accepted',
      'parcel.arrived_at_hub',
      'parcel.out_for_delivery',
      'parcel.delivered',
    ])('accepts %s', async (event_type) => {
      await expect(insert('tracking_events', eventRow({ event_type }))).resolves.toBeDefined()
    })

    it('rejects an event type Tracking does not consume', async () => {
      await expect(insert('tracking_events', eventRow({ event_type: 'sla.breached' }))).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      })
    })

    it('requires a positive stream_sequence', async () => {
      await expect(insert('tracking_events', eventRow({ stream_sequence: null }))).rejects.toMatchObject({
        code: NOT_NULL_VIOLATION,
      })
      await expect(insert('tracking_events', eventRow({ stream_sequence: 0 }))).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      })
    })

    it('has an index on shipment_id', async () => {
      expect(await indexDefinition('tracking_events_shipment_id_idx')).toMatch(/\(shipment_id\)$/)
    })
  })

  describe('shipment_tracking', () => {
    it.each([
      ['REGISTERED', { last_location: null }],
      ['ACCEPTED', {}],
      ['AT_HUB', {}],
      ['OUT_FOR_DELIVERY', {}],
      ['DELIVERED', { delivered_at: TIME }],
    ])('accepts the status %s', async (status, overrides) => {
      await expect(insert('shipment_tracking', trackingRow({ status, ...overrides }))).resolves.toBeDefined()
    })

    it.each([
      ['an unknown status', { status: 'LOST' }],
      ['a REGISTERED shipment with a location', { status: 'REGISTERED' }],
      ['a scanned shipment without a location', { last_location: null }],
      ['a DELIVERED shipment without delivered_at', { status: 'DELIVERED' }],
      ['delivered_at before the delivery', { delivered_at: TIME }],
    ])('rejects %s', async (_name, overrides) => {
      await expect(insert('shipment_tracking', trackingRow(overrides))).rejects.toMatchObject({ code: CHECK_VIOLATION })
    })

    it('has one row per shipment', async () => {
      const row = trackingRow()
      await insert('shipment_tracking', row)

      await expect(insert('shipment_tracking', row)).rejects.toMatchObject({ code: UNIQUE_VIOLATION })
    })
  })

  describe('tracking_history', () => {
    it('accepts an entry of a known shipment and a stored event', async () => {
      await expect(insert('tracking_history', historyRow(await knownShipment()))).resolves.toBeDefined()
    })

    it.each([
      ['an unknown status', { status: 'LOST' }],
      ['position 0', { position: 0 }],
    ])('rejects %s', async (_name, overrides) => {
      await expect(
        insert('tracking_history', historyRow({ ...(await knownShipment()), ...overrides })),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION })
    })

    it('rejects two entries at the same position of a shipment', async () => {
      const known = await knownShipment()
      const otherEventId = randomUUID()
      await insert('tracking_events', eventRow({ event_id: otherEventId, shipment_id: known.shipment_id }))
      await insert('tracking_history', historyRow(known))

      await expect(
        insert('tracking_history', historyRow({ ...known, event_id: otherEventId })),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'tracking_history_pkey' })
    })

    it('rejects the same event twice', async () => {
      const known = await knownShipment()
      await insert('tracking_history', historyRow(known))

      await expect(insert('tracking_history', historyRow({ ...known, position: 2 }))).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: 'tracking_history_event_id_key',
      })
    })

    it.each(['shipment_id', 'event_id'])('rejects an unknown %s', async (column) => {
      await expect(
        insert('tracking_history', historyRow({ ...(await knownShipment()), [column]: randomUUID() })),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION })
    })
  })

  describe('quarantined_events', () => {
    it('accepts a conflict, with id and detected_at set', async () => {
      await insert('quarantined_events', quarantineRow())

      const { rows } = await service.query('SELECT id, detected_at FROM quarantined_events')
      expect(rows).toEqual([{ id: expect.any(String), detected_at: expect.any(Date) }])
    })

    it.each([
      ['the reason INVALID (lesson 3.4)', { reason: 'INVALID' }],
      ['a conflict without event_id', { event_id: null }],
      ['a conflict without shipment_id', { shipment_id: null }],
      ['a conflict whose details are not a list', { details: '{}' }],
    ])('rejects %s', async (_name, overrides) => {
      await expect(insert('quarantined_events', quarantineRow(overrides))).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      })
    })

    it('requires a unique stream_sequence', async () => {
      const row = quarantineRow()
      await insert('quarantined_events', row)

      await expect(
        insert('quarantined_events', quarantineRow({ stream_sequence: row.stream_sequence })),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION })
      await expect(insert('quarantined_events', quarantineRow({ stream_sequence: null }))).rejects.toMatchObject({
        code: NOT_NULL_VIOLATION,
      })
    })

    it('has indexes for the anomalies of both shipments', async () => {
      expect(await indexDefinition('quarantined_events_shipment_id_idx')).toMatch(/\(shipment_id\)$/)
      expect(await indexDefinition('quarantined_events_payload_shipment_id_idx')).toMatch(
        /\(lower\(\(payload ->> 'shipmentId'::text\)\)\)$/,
      )
    })
  })
})

describe('migrations down and up again', () => {
  it('down removes the tables in reverse order, up recreates them', async () => {
    expect((await run('down')).map((m) => m.name)).toEqual([MIGRATIONS[2]])
    expect(await tables()).toEqual(['shipment_tracking', 'tracking_events', 'tracking_history'])

    expect((await run('down')).map((m) => m.name)).toEqual([MIGRATIONS[1]])
    expect(await tables()).toEqual(['tracking_events'])

    expect((await run('down')).map((m) => m.name)).toEqual([MIGRATIONS[0]])
    expect(await tables()).toEqual([])

    expect((await run('up')).map((m) => m.name)).toEqual(MIGRATIONS)
    expect(await tables()).toEqual(TABLES)

    // The recreated tables are usable by tracking_service again (default privileges).
    await expect(insert('tracking_history', historyRow(await knownShipment()))).resolves.toBeDefined()
    await expect(insert('quarantined_events', quarantineRow())).resolves.toBeDefined()
  })
})
