import type { NatsConnection } from '@nats-io/transport-node'
import type pg from 'pg'

export type Readiness = { database: boolean; nats: boolean }
export type CheckReadiness = () => Promise<Readiness>

const CHECK_TIMEOUT_MS = 2_000

/** Resolves true if `check` succeeds within CHECK_TIMEOUT_MS, otherwise false. */
async function passes(check: () => Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS)
  })
  try {
    return await Promise.race([check().then(() => true, () => false), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Ready = a database query works and the NATS connection is up (rtt() throws while disconnected). */
export function createReadinessCheck(deps: { pool: pg.Pool; nc: NatsConnection }): CheckReadiness {
  return async () => {
    const [database, nats] = await Promise.all([
      passes(() => deps.pool.query('SELECT 1')),
      passes(() => deps.nc.rtt()),
    ])
    return { database, nats }
  }
}
