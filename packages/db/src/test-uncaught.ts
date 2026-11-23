// Test helper only; not exported from index.ts.

/**
 * Runs `work` and returns the errors that would have ended the process
 * meanwhile. Takes the place of the test runner's own listeners, which would
 * report such an error for the whole run and not fail the test.
 */
export async function uncaughtErrorsDuring(work: () => Promise<void>): Promise<unknown[]> {
  const errors: unknown[] = []
  const collect = (err: unknown) => void errors.push(err)
  const others = process.listeners('uncaughtException')
  process.removeAllListeners('uncaughtException')
  process.on('uncaughtException', collect)
  try {
    await work()
  } finally {
    process.removeListener('uncaughtException', collect)
    for (const listener of others) process.on('uncaughtException', listener)
  }
  return errors
}
