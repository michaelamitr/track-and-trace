import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startNats, type TestNats } from '@tt/messaging/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))

let nats: TestNats

beforeAll(async () => {
  // A fresh server without the stream (pnpm nats:setup has not run).
  nats = await startNats()
})

afterAll(async () => {
  await nats?.stop()
})

/** Starts main.ts like `pnpm start` and expects it to exit with an error. */
async function startServiceExpectingFailure(env: Record<string, string>) {
  try {
    await run(TSX, ['src/main.ts'], {
      cwd: PACKAGE_DIR,
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 20_000,
    })
  } catch (err) {
    const { code, stdout, stderr } = err as { code: number; stdout: string; stderr: string }
    return { code, output: stdout + stderr }
  }
  throw new Error('main.ts exited successfully')
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
