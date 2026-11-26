import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import setup from './test-global-setup.js'
import { PROCESS_DIR_VARIABLE, startProcess, stopProcess } from './test-process.js'

describe('test-global-setup', () => {
  it('records running children and kills those left at the teardown, also ones that ignore SIGTERM', async () => {
    const previous = process.env[PROCESS_DIR_VARIABLE]
    const teardown = setup()
    const dir = process.env[PROCESS_DIR_VARIABLE]!
    try {
      const stubborn = startProcess({
        cwd: process.cwd(),
        args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      })
      const stopped = startProcess({ cwd: process.cwd(), args: ['-e', 'setInterval(() => {}, 1000)'] })
      expect(readdirSync(dir).sort()).toEqual([String(stubborn.child.pid), String(stopped.child.pid)].sort())

      await stopProcess(stopped)
      expect(readdirSync(dir)).toEqual([String(stubborn.child.pid)])

      teardown()

      expect(await stubborn.exited).toEqual({ code: null, signal: 'SIGKILL' })
      expect(existsSync(dir)).toBe(false)
    } finally {
      if (previous === undefined) delete process.env[PROCESS_DIR_VARIABLE]
      else process.env[PROCESS_DIR_VARIABLE] = previous
    }
  })
})
