import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanUpAfterFailedStart, runShutdown, SHUTDOWN_DEADLINE_MS } from './shutdown.js'

afterEach(() => {
  vi.useRealTimers()
})

function logger() {
  return { info: vi.fn(), error: vi.fn() }
}

describe('runShutdown', () => {
  it('runs the steps one after another, in order, and resolves to 0', async () => {
    const order: string[] = []
    const step = (name: string) => ({
      name,
      run: async () => {
        order.push(`${name} started`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push(`${name} done`)
      },
    })

    const code = await runShutdown([step('consumer'), step('http'), step('nats'), step('pool')], { log: logger() })

    expect(code).toBe(0)
    expect(order).toEqual([
      'consumer started',
      'consumer done',
      'http started',
      'http done',
      'nats started',
      'nats done',
      'pool started',
      'pool done',
    ])
  })

  it('logs a failed step, still runs the next ones and resolves to 1', async () => {
    const log = logger()
    const err = new Error('boom')
    const after = vi.fn(async () => {})

    const code = await runShutdown(
      [
        { name: 'http', run: () => Promise.reject(err) },
        { name: 'pool', run: after },
      ],
      { log },
    )

    expect(code).toBe(1)
    expect(after).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalledWith({ err, step: 'http' }, 'shutdown step failed')
  })

  it('has a deadline of 8 s', () => {
    expect(SHUTDOWN_DEADLINE_MS).toBe(8_000)
  })

  it('resolves to 1 and logs an error when the deadline passes, without waiting for the stuck step', async () => {
    vi.useFakeTimers()
    const log = logger()
    const never = vi.fn(async () => {})

    const result = runShutdown(
      [
        { name: 'consumer', run: () => new Promise(() => {}) },
        { name: 'pool', run: never },
      ],
      { log },
    )
    let code: number | undefined
    void result.then((value) => (code = value))

    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1)
    expect(code).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)

    expect(code).toBe(1)
    expect(never).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith({ deadlineMs: 8_000 }, 'shutdown did not finish within the deadline, exiting')
  })
})

describe('cleanUpAfterFailedStart', () => {
  it('runs every step and resolves to 1, because the start failed', async () => {
    const log = logger()
    const steps = [vi.fn(async () => {}), vi.fn(async () => {})]

    const code = await cleanUpAfterFailedStart(
      steps.map((run, index) => ({ name: `step ${index}`, run })),
      { log },
    )

    expect(code).toBe(1)
    for (const step of steps) expect(step).toHaveBeenCalledOnce()
    expect(log.info).toHaveBeenCalledWith({}, 'cleanup after a failed start complete')
  })

  it('resolves to 1 within the deadline when a step hangs', async () => {
    vi.useFakeTimers()
    const log = logger()

    const result = cleanUpAfterFailedStart(
      [
        { name: 'nats', run: () => new Promise(() => {}) },
        { name: 'pool', run: async () => {} },
      ],
      { log },
    )
    let code: number | undefined
    void result.then((value) => (code = value))

    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1)
    expect(code).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)

    expect(code).toBe(1)
    expect(log.error).toHaveBeenCalledWith(
      { deadlineMs: 8_000 },
      'cleanup after a failed start did not finish within the deadline, exiting',
    )
  })

  it('resolves to 1 when a step fails', async () => {
    const code = await cleanUpAfterFailedStart([{ name: 'pool', run: () => Promise.reject(new Error('boom')) }], {
      log: logger(),
    })

    expect(code).toBe(1)
  })
})
