import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { runMigrations, verifyNoPendingMigrations } from '@tt/db'
import { TEST_PASSWORDS } from '@tt/db/testing'
import { LOGISTICS_STREAM, publishEvent, setupNats } from '@tt/messaging'
import { startNats, type TestNats } from '@tt/messaging/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIGRATIONS_DIR } from './db/migrations.js'
import { parcel, registered, SHIPMENT_ID } from './test-events.js'
import { clearTables, readModel, startTestDatabase, receivedMessages, type TestDatabase } from './test-support.js'

type RunningService = {
  child: ChildProcess
  /** stdout and stderr so far. */
  output(): string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const SERVICE_PASSWORD = TEST_PASSWORDS.tracking_service

let db: TestDatabase
let nats: TestNats
let running: RunningService | undefined

beforeAll(async () => {
  ;[db, nats] = await Promise.all([startTestDatabase({ restartable: true }), startNats()])
})

afterAll(async () => {
  await Promise.all([db?.stop(), nats?.stop()])
})

beforeEach(async () => {
  await clearTables(db.owner)
  await nats.jsm.streams.delete(LOGISTICS_STREAM.name).catch(() => {})
})

afterEach(() => {
  running?.child.kill('SIGKILL')
  running = undefined
})

/** Runs main.ts in its own process with only the given variables (no .env). */
function startService(env: Record<string, string>): RunningService {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env.PATH ?? '', ...env },
  })
  let output = ''
  child.stdout?.on('data', (chunk) => (output += chunk))
  child.stderr?.on('data', (chunk) => (output += chunk))
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }))
  running = { child, output: () => output, exited }
  return running
}

async function startServiceExpectingFailure(env: Record<string, string>) {
  const service = startService(env)
  const { code } = await service.exited
  return { code, output: service.output() }
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  server.close()
  await once(server, 'close')
  return port
}

/** A running service that answers HTTP requests. */
async function startReadyService() {
  await setupNats(nats.jsm)
  const port = await freePort()
  const service = startService({
    TRACKING_DATABASE_URL: db.serviceUrl,
    NATS_URL: nats.url,
    TRACKING_PORT: String(port),
  })
  const url = `http://127.0.0.1:${port}`
  await vi.waitFor(async () => expect((await fetch(`${url}/health/live`)).status).toBe(200), {
    timeout: 15_000,
    interval: 100,
  })
  return { ...service, url }
}

const consumerInfo = () => nats.jsm.consumers.info(LOGISTICS_STREAM.name, 'tracking')

describe('startup', () => {
  it('passes the migration check when every migration has run', async () => {
    await expect(verifyNoPendingMigrations(db.pool, MIGRATIONS_DIR)).resolves.toBeUndefined()
  })

  it('fails fast when a migration is pending, without logging the connection string', async () => {
    await runMigrations({ databaseUrl: db.ownerUrl, dir: MIGRATIONS_DIR, direction: 'down', log: () => {} })
    try {
      const { code, output } = await startServiceExpectingFailure({
        TRACKING_DATABASE_URL: db.serviceUrl,
        // Never reached: the migration check comes first.
        NATS_URL: 'nats://127.0.0.1:1',
      })

      expect(code).toBe(1)
      expect(output).toContain(
        'Pending migrations: 1795447896000_create-quarantined-events. Run pnpm db:migrate first.',
      )
      expect(output).not.toContain(SERVICE_PASSWORD)
    } finally {
      await runMigrations({ databaseUrl: db.ownerUrl, dir: MIGRATIONS_DIR, direction: 'up', log: () => {} })
    }
  })

  it('fails fast when NATS is unreachable', async () => {
    const { code, output } = await startServiceExpectingFailure({
      TRACKING_DATABASE_URL: db.serviceUrl,
      NATS_URL: 'nats://127.0.0.1:1',
    })

    expect(code).toBe(1)
    expect(output).toContain('startup failed')
    expect(output).not.toContain(SERVICE_PASSWORD)
  })

  it('fails fast when the stream is missing', async () => {
    const { code, output } = await startServiceExpectingFailure({
      TRACKING_DATABASE_URL: db.serviceUrl,
      NATS_URL: nats.url,
    })

    expect(code).toBe(1)
    expect(output).toContain('Stream LOGISTICS_EVENTS not found. Run `pnpm nats:setup` first.')
  })

  it('fails fast when the "tracking" consumer is missing', async () => {
    await setupNats(nats.jsm)
    await nats.jsm.consumers.delete(LOGISTICS_STREAM.name, 'tracking')

    const { code, output } = await startServiceExpectingFailure({
      TRACKING_DATABASE_URL: db.serviceUrl,
      NATS_URL: nats.url,
    })

    expect(code).toBe(1)
    expect(output).toContain('Consumer tracking on stream LOGISTICS_EVENTS not found. Run `pnpm nats:setup` first.')
  })

  it('fails fast with a clear message when TRACKING_DATABASE_URL is missing', async () => {
    const { code, output } = await startServiceExpectingFailure({})

    expect(code).toBe(1)
    expect(output).toContain('TRACKING_DATABASE_URL is not set')
  })
})

describe('running service', () => {
  it('is ready, processes an event, serves it over HTTP, logs it as service "tracking" and exits with 0 on SIGTERM', async () => {
    const service = await startReadyService()
    const ready = await fetch(`${service.url}/health/ready`)
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ status: 'ready', checks: { database: 'ok', nats: 'ok' } })

    const event = registered('2026-10-28T08:00:00Z')
    const { seq } = await publishEvent(nats.js, event)
    await vi.waitFor(async () => expect((await consumerInfo()).ack_floor.stream_seq).toBe(seq), { timeout: 10_000 })

    expect((await readModel(db.pool, SHIPMENT_ID))?.state.status).toBe('REGISTERED')
    const bodies = { '': { status: 'REGISTERED' }, '/history': { events: [{ eventId: event.eventId }] }, '/anomalies': { conflicts: [] } }
    for (const [suffix, body] of Object.entries(bodies)) {
      const res = await fetch(`${service.url}/tracking/${SHIPMENT_ID}${suffix}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ shipmentId: SHIPMENT_ID, ...body })
    }
    const lines = service.output().split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
    expect(lines.filter((line) => line.result)).toMatchObject([
      { service: 'tracking', eventId: event.eventId, streamSequence: seq, result: 'processed' },
    ])

    service.child.kill('SIGTERM')
    expect(await service.exited).toEqual({ code: 0, signal: null })
    expect(service.output()).not.toContain(SERVICE_PASSWORD)
  })

  it('finishes and acks the message in progress on SIGTERM, then exits with 0', async () => {
    const service = await startReadyService()
    const blocker = await db.owner.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE received_messages IN ACCESS EXCLUSIVE MODE')
      await publishEvent(nats.js, registered('2026-10-28T08:00:00Z'))
      await vi.waitFor(async () => expect((await consumerInfo()).num_ack_pending).toBe(1), { timeout: 10_000 })

      service.child.kill('SIGTERM')
      await vi.waitFor(() => expect(service.output()).toContain('shutting down'))
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(service.child.exitCode).toBeNull()

      await blocker.query('COMMIT')
    } finally {
      blocker.release()
    }

    expect(await service.exited).toEqual({ code: 0, signal: null })
    expect(await receivedMessages(db.pool)).toHaveLength(1)
    const info = await consumerInfo()
    expect(info.num_ack_pending).toBe(0)
    expect(info.ack_floor.stream_seq).toBe(1)
  })

  it.each(['fast', 'kill'] as const)(
    'survives a database outage (%s) while a message is processed and works after it',
    async (mode) => {
      const service = await startReadyService()
      await publishEvent(nats.js, registered('2026-10-28T08:00:00Z'))
      await vi.waitFor(async () => expect((await consumerInfo()).ack_floor.stream_seq).toBe(1), { timeout: 10_000 })
      const blocker = await db.owner.connect()
      blocker.on('error', () => {})
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE received_messages IN ACCESS EXCLUSIVE MODE')
      await publishEvent(nats.js, parcel('parcel.accepted', '2026-10-28T08:15:00Z'))
      await vi.waitFor(async () => {
        const { rows } = await db.owner.query("SELECT 1 FROM pg_locks WHERE NOT granted AND relation = 'received_messages'::regclass")
        expect(rows).toHaveLength(1)
      })

      try {
        await db.postgres.stopServer(mode)
        blocker.release(true)

        await vi.waitFor(async () => {
          expect((await fetch(`${service.url}/health/ready`)).status).toBe(503)
        })
        expect((await fetch(`${service.url}/tracking/${SHIPMENT_ID}`)).status).toBe(503)
        // Long enough for a late error of the lost connection.
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect((await fetch(`${service.url}/health/live`)).status).toBe(200)
        expect(service.child.exitCode).toBeNull()
      } finally {
        await db.postgres.startServer()
      }

      expect((await fetch(`${service.url}/health/ready`)).status).toBe(200)
      // The interrupted message may have used up its deliveries (lesson 3.4); a new one is processed.
      const { seq } = await publishEvent(nats.js, parcel('parcel.arrived_at_hub', '2026-10-28T09:30:00Z'))
      await vi.waitFor(
        async () => {
          const rows = await receivedMessages(db.pool)
          expect(rows.map((row) => row.stream_sequence)).toContain(String(seq))
        },
        { timeout: 10_000 },
      )
      const res = await fetch(`${service.url}/tracking/${SHIPMENT_ID}`)
      expect(await res.json()).toMatchObject({ status: 'AT_HUB' })
    },
    60_000,
  )

  it('exits with 1 when its port is taken', async () => {
    const first = await startReadyService()
    const { code, output } = await startServiceExpectingFailure({
      TRACKING_DATABASE_URL: db.serviceUrl,
      NATS_URL: nats.url,
      TRACKING_PORT: new URL(first.url).port,
    })
    first.child.kill('SIGKILL')

    expect(code).toBe(1)
    expect(output).toContain('startup failed')
  })
})
