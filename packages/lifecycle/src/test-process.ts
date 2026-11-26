// Test helper only; not exported from index.ts. Services' tests import it
// through the "@tt/lifecycle/testing" subpath.
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Set by test-global-setup.ts: where the pids of running children are recorded. */
export const PROCESS_DIR_VARIABLE = 'TT_TEST_PROCESS_DIR'

export type Exit = { code: number | null; signal: NodeJS.Signals | null }

export type TestProcess = {
  child: ChildProcess
  /** stdout and stderr so far. */
  output(): string
  exited: Promise<Exit>
}

/** Every process started here that has not exited yet. */
const live = new Set<TestProcess>()

// Last resort if the test process ends without stopping them (a crash, a
// killed worker): no child may outlive it and keep a container in use.
process.once('exit', () => {
  for (const proc of live) proc.child.kill('SIGKILL')
})

/**
 * Starts `node <args>` in `cwd` with only PATH and `env` as its environment.
 * One process, no wrapper (such as the tsx binary) whose child could survive a SIGKILL.
 */
export function startProcess(options: { cwd: string; args: string[]; env?: Record<string, string> }): TestProcess {
  const child = spawn(process.execPath, options.args, {
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? '', ...options.env },
  })
  let output = ''
  child.stdout?.on('data', (chunk) => (output += chunk))
  child.stderr?.on('data', (chunk) => (output += chunk))
  const proc: TestProcess = {
    child,
    output: () => output,
    exited: once(child, 'exit').then(([code, signal]) => ({ code, signal }) as Exit),
  }
  live.add(proc)
  // For the teardown of test-global-setup.ts, if this worker ends without stopping the child.
  const dir = process.env[PROCESS_DIR_VARIABLE]
  const pidFile = dir && child.pid ? join(dir, String(child.pid)) : undefined
  if (pidFile) writeFileSync(pidFile, '')
  void proc.exited.then(() => {
    live.delete(proc)
    if (pidFile) rmSync(pidFile, { force: true })
  })
  return proc
}

/** Starts a service's src/main.ts like `pnpm start`, without .env. */
export function startService(options: { cwd: string; env?: Record<string, string> }): TestProcess {
  return startProcess({ ...options, args: ['--import', 'tsx', 'src/main.ts'] })
}

function hasExited(proc: TestProcess): boolean {
  return proc.child.exitCode !== null || proc.child.signalCode !== null
}

/** SIGTERM, then SIGKILL if it has not exited after `graceMs`; resolves once it has exited. */
export async function stopProcess(proc: TestProcess, graceMs = 2_000): Promise<Exit> {
  if (hasExited(proc)) return proc.exited
  proc.child.kill('SIGTERM')
  const timer = setTimeout(() => proc.child.kill('SIGKILL'), graceMs)
  try {
    return await proc.exited
  } finally {
    clearTimeout(timer)
  }
}

/** For afterEach: ends every process still running, whether the test passed, failed or timed out. */
export async function stopAllProcesses(graceMs?: number): Promise<void> {
  await Promise.all([...live].map((proc) => stopProcess(proc, graceMs)))
}

/** How many started processes are still running. */
export function liveProcessCount(): number {
  return live.size
}
