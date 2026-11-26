import { afterEach, describe, expect, it } from 'vitest'
import { liveProcessCount, startProcess, stopAllProcesses, stopProcess } from './test-process.js'

const cwd = process.cwd()

/** A process that is up once it printed "ready". */
async function started(script: string) {
  const proc = startProcess({ cwd, args: ['-e', script] })
  while (!proc.output().includes('ready')) await new Promise((resolve) => setTimeout(resolve, 10))
  return proc
}

afterEach(async () => {
  await stopAllProcesses(100)
})

describe('stopProcess', () => {
  it('ends a process with SIGTERM when it exits on it', async () => {
    const proc = await started("console.log('ready'); setInterval(() => {}, 1000)")

    expect(await stopProcess(proc, 5_000)).toEqual({ code: null, signal: 'SIGTERM' })
  })

  it('kills a process that ignores SIGTERM after the grace time', async () => {
    const proc = await started("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)")
    const begin = Date.now()

    expect(await stopProcess(proc, 300)).toEqual({ code: null, signal: 'SIGKILL' })
    expect(Date.now() - begin).toBeGreaterThanOrEqual(250)
  })

  it('returns at once for a process that has already exited', async () => {
    const proc = startProcess({ cwd, args: ['-e', 'process.exit(3)'] })
    await proc.exited

    expect(await stopProcess(proc)).toEqual({ code: 3, signal: null })
  })
})

describe('stopAllProcesses', () => {
  it('ends every process still running, also one that ignores SIGTERM', async () => {
    await started("console.log('ready'); setInterval(() => {}, 1000)")
    await started("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)")
    expect(liveProcessCount()).toBe(2)

    await stopAllProcesses(300)

    expect(liveProcessCount()).toBe(0)
  })
})
