/** Docker kills the process 10 s after SIGTERM; the shutdown must be done before (ADR-0015 rule 5). */
export const SHUTDOWN_DEADLINE_MS = 8_000

export type ShutdownLogger = {
  info(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

/** One step of the shutdown, such as "stop consuming" or "close HTTP". */
export type ShutdownStep = { name: string; run: () => Promise<unknown> }

/**
 * Runs the steps in order and resolves to the exit code; never rejects.
 * 0: every step finished within the deadline. 1: a step failed (it is logged
 * and the remaining steps still run, so connections are closed) or the
 * deadline passed (logged as an error; the steps still running are abandoned
 * and the caller exits).
 */
export async function runShutdown(
  steps: ShutdownStep[],
  options: { log: ShutdownLogger; deadlineMs?: number; what?: string },
): Promise<number> {
  const { log } = options
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS
  const what = options.what ?? 'shutdown'

  async function runAll(): Promise<number> {
    let code = 0
    for (const step of steps) {
      try {
        await step.run()
      } catch (err) {
        log.error({ err, step: step.name }, `${what} step failed`)
        code = 1
      }
    }
    return code
  }

  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      log.error({ deadlineMs }, `${what} did not finish within the deadline, exiting`)
      resolve(1)
    }, deadlineMs)
  })
  try {
    const code = await Promise.race([runAll(), deadline])
    if (code === 0) log.info({}, `${what} complete`)
    return code
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Closes whatever a failed start had already opened, with the same deadline
 * as a shutdown, and resolves to the exit code: always 1, because the start
 * failed. A hanging step cannot keep a process alive that does nothing.
 */
export async function cleanUpAfterFailedStart(
  steps: ShutdownStep[],
  options: { log: ShutdownLogger; deadlineMs?: number },
): Promise<number> {
  await runShutdown(steps, { ...options, what: 'cleanup after a failed start' })
  return 1
}
