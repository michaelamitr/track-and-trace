import { fileURLToPath } from 'node:url'
import { startService, stopAllProcesses } from '@tt/lifecycle/testing'
import { startNats, type TestNats } from '@tt/messaging/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

let nats: TestNats

beforeAll(async () => {
  // A fresh server without the stream (pnpm nats:setup has not run).
  nats = await startNats()
})

afterAll(async () => {
  await nats?.stop()
})

// Every started service ends here, also when its test failed or timed out:
// SIGTERM, then SIGKILL; before the containers are stopped in afterAll.
afterEach(async () => {
  await stopAllProcesses()
})

/** Starts main.ts like `pnpm start` (without .env) and expects it to exit with an error. */
async function startServiceExpectingFailure(env: Record<string, string>) {
  const service = startService({ cwd: PACKAGE_DIR, env })
  const { code } = await service.exited
  if (code === 0) throw new Error('main.ts exited successfully')
  return { code, output: service.output() }
}

describe('startup', () => {
  it('fails fast when NATS is unreachable', async () => {
    const { code, output } = await startServiceExpectingFailure({ NATS_URL: 'nats://127.0.0.1:1' })

    expect(code).toBe(1)
    expect(output).toContain('startup failed')
  })

  it('fails fast when the stream is missing', async () => {
    const { code, output } = await startServiceExpectingFailure({ NATS_URL: nats.url })

    expect(code).toBe(1)
    expect(output).toContain('Run `pnpm nats:setup` first.')
  })

  it('fails fast with a clear message for an invalid port', async () => {
    const { code, output } = await startServiceExpectingFailure({ SCAN_INGESTION_PORT: 'abc' })

    expect(code).toBe(1)
    expect(output).toContain('SCAN_INGESTION_PORT must be an integer')
  })
})
