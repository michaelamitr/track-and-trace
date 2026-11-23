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
  '1795447776000_create-received-messages',
  '1795447836000_create-read-model',
  '1795447896000_create-quarantined-events',
]
const TABLES = ['quarantined_events', 'received_messages', 'shipment_tracking', 'tracking_conflicts', 'tracking_history']
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

let sequence = 0
function messageRow(overrides: Row = {}): Row {
  sequence += 1
  return {
    stream_sequence: sequence,
    event_id: randomUUID(),
    shipment_id: randomUUID(),
    event_type: 'parcel.accepted',
    occurred_at: TIME,
    received_at: TIME,
    payload: '{}',
    subject: 'logistics.parcel.accepted.v1',
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

function quarantineRow(overrides: Row = {}): Row {
  sequence += 1
  return {
    reason: 'INVALID',
    event_id: randomUUID(),
    shipment_id: randomUUID(),
    subject: 'logistics.parcel.accepted.v1',
    stream_sequence: sequence,
    payload: '{}',
    details: '{}',
    ...overrides,
  }
}

/** A known shipment with one received message, so a read-model row can refer to both. */
async function knownShipment() {
  const message = messageRow()
  await insert('received_messages', message)
  await insert('shipment_tracking', trackingRow({ shipment_id: message.shipment_id }))
  return message
}

async function knownHistoryRow(overrides: Row = {}): Promise<Row> {
  const { shipment_id, event_id } = await knownShipment()
  return historyRow({ shipment_id, event_id, ...overrides })
}

async function knownConflictRow(overrides: Row = {}): Promise<Row> {
  const { shipment_id, event_id, stream_sequence } = await knownShipment()
  return {
    shipment_id,
    event_id,
    stream_sequence,
    received_at: TIME,
    differing_fields: ['data.facilityId'],
    ...overrides,
  }
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
    for (const table of [
      'tracking_conflicts',
      'tracking_history',
      'shipment_tracking',
      'received_messages',
      'quarantined_events',
    ]) {
      await service.query(`DELETE FROM ${table}`)
    }
  })

  it('has exactly the five tables of ADR-0014', async () => {
    expect(await tables()).toEqual(TABLES)
  })

  it.each(TABLES)('cannot drop %s', async (table) => {
    await expect(service.query(`DROP TABLE ${table}`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
    expect(await tables()).toContain(table)
  })

  describe('received_messages', () => {
    it('stores a stream_sequence once', async () => {
      const row = messageRow()
      await insert('received_messages', row)

      await expect(
        insert('received_messages', messageRow({ stream_sequence: row.stream_sequence })),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'received_messages_pkey' })
    })

    it('stores several copies of an event', async () => {
      const row = messageRow()
      await insert('received_messages', row)

      await expect(insert('received_messages', messageRow({ event_id: row.event_id }))).resolves.toBeDefined()
    })

    it.each([
      'shipment.registered',
      'parcel.accepted',
      'parcel.arrived_at_hub',
      'parcel.out_for_delivery',
      'parcel.delivered',
    ])('accepts %s', async (event_type) => {
      await expect(insert('received_messages', messageRow({ event_type }))).resolves.toBeDefined()
    })

    it.each([
      ['an event type Tracking does not consume', { event_type: 'sla.breached' }],
      ['a stream_sequence that is not positive', { stream_sequence: 0 }],
    ])('rejects %s', async (_name, overrides) => {
      await expect(insert('received_messages', messageRow(overrides))).rejects.toMatchObject({ code: CHECK_VIOLATION })
    })

    it.each(['event_id', 'shipment_id'])('has an index on %s', async (column) => {
      expect(await indexDefinition(`received_messages_${column}_idx`)).toMatch(new RegExp(`\\(${column}\\)$`))
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
    it('accepts an entry of a known shipment', async () => {
      await expect(insert('tracking_history', await knownHistoryRow())).resolves.toBeDefined()
    })

    it.each([
      ['an unknown status', { status: 'LOST' }],
      ['position 0', { position: 0 }],
    ])('rejects %s', async (_name, overrides) => {
      await expect(insert('tracking_history', await knownHistoryRow(overrides))).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      })
    })

    it('rejects two entries at the same position of a shipment', async () => {
      const row = await knownHistoryRow()
      await insert('tracking_history', row)

      await expect(insert('tracking_history', { ...row, event_id: randomUUID() })).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: 'tracking_history_pkey',
      })
    })

    it('rejects the same event twice', async () => {
      const row = await knownHistoryRow()
      await insert('tracking_history', row)

      await expect(insert('tracking_history', { ...row, position: 2 })).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: 'tracking_history_event_id_key',
      })
    })

    it('rejects an unknown shipment', async () => {
      await expect(insert('tracking_history', historyRow())).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION })
    })
  })

  describe('tracking_conflicts', () => {
    it('accepts a conflict under two known shipments', async () => {
      const row = await knownConflictRow()
      const other = await knownShipment()
      await insert('tracking_conflicts', row)

      await expect(insert('tracking_conflicts', { ...row, shipment_id: other.shipment_id })).resolves.toBeDefined()
    })

    it('requires received_at', async () => {
      await expect(
        insert('tracking_conflicts', await knownConflictRow({ received_at: null })),
      ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION })
    })

    it('lists a copy once per shipment', async () => {
      const row = await knownConflictRow()
      await insert('tracking_conflicts', row)

      await expect(insert('tracking_conflicts', row)).rejects.toMatchObject({ code: UNIQUE_VIOLATION })
    })

    it('rejects a conflict without differing fields', async () => {
      await expect(
        insert('tracking_conflicts', await knownConflictRow({ differing_fields: [] })),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION })
    })

    it.each([
      ['shipment', { shipment_id: randomUUID() }],
      ['message', { stream_sequence: 1_000_000 }],
    ])('rejects an unknown %s', async (_name, overrides) => {
      await expect(insert('tracking_conflicts', await knownConflictRow(overrides))).rejects.toMatchObject({
        code: FOREIGN_KEY_VIOLATION,
      })
    })
  })

  describe('quarantined_events', () => {
    it('accepts an invalid message without ids, with id and detected_at set', async () => {
      await insert('quarantined_events', quarantineRow({ event_id: null, shipment_id: null }))

      const { rows } = await service.query('SELECT id, detected_at FROM quarantined_events')
      expect(rows).toEqual([{ id: expect.any(String), detected_at: expect.any(Date) }])
    })

    it('rejects the reason CONFLICT: conflicts are in tracking_conflicts', async () => {
      await expect(insert('quarantined_events', quarantineRow({ reason: 'CONFLICT' }))).rejects.toMatchObject({
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
  })
})

describe('wall-clock values', () => {
  it('only shipment_tracking.updated_at and the quarantine have one; nothing else is set by a clock', async () => {
    const { rows } = await service.query(
      `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> 'pgmigrations'
          AND data_type LIKE 'timestamp%' AND column_name NOT IN ('occurred_at', 'received_at')
        ORDER BY name`,
    )
    expect(rows.map((row) => row.name)).toEqual([
      'quarantined_events.detected_at',
      'shipment_tracking.delivered_at',
      'shipment_tracking.last_event_at',
      'shipment_tracking.updated_at',
    ])
  })
})

describe('migrations down and up again', () => {
  it('down removes the tables in reverse order, up recreates them', async () => {
    expect((await run('down')).map((m) => m.name)).toEqual([MIGRATIONS[2]])
    expect(await tables()).toEqual(['received_messages', 'shipment_tracking', 'tracking_conflicts', 'tracking_history'])

    expect((await run('down')).map((m) => m.name)).toEqual([MIGRATIONS[1]])
    expect(await tables()).toEqual(['received_messages'])

    expect((await run('down')).map((m) => m.name)).toEqual([MIGRATIONS[0]])
    expect(await tables()).toEqual([])

    expect((await run('up')).map((m) => m.name)).toEqual(MIGRATIONS)
    expect(await tables()).toEqual(TABLES)

    // The recreated tables are usable by tracking_service again (default privileges).
    await expect(insert('tracking_history', await knownHistoryRow())).resolves.toBeDefined()
    await expect(insert('tracking_conflicts', await knownConflictRow())).resolves.toBeDefined()
    await expect(insert('quarantined_events', quarantineRow())).resolves.toBeDefined()
  })
})
