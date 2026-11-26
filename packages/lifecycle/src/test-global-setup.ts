// Vitest globalSetup for test runs that start processes (startProcess). Not
// exported from index.ts.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROCESS_DIR_VARIABLE } from './test-process.js'

/**
 * Gives the run a directory in which startProcess records the pid of every
 * child that is still running. The teardown kills what is left: children of a
 * test worker that was ended (after a hook timeout, say) without running its
 * afterEach or its 'exit' listeners, and that would keep a container in use.
 */
export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'tt-test-processes-'))
  process.env[PROCESS_DIR_VARIABLE] = dir
  return () => {
    for (const name of readdirSync(dir)) {
      try {
        process.kill(Number(name), 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}
