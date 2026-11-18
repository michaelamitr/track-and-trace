import type { NatsConnection } from '@nats-io/transport-node'

export type Readiness = { nats: boolean }
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

/** Ready = the NATS connection is up (rtt() throws while disconnected). No database. */
export function createReadinessCheck(deps: { nc: NatsConnection }): CheckReadiness {
  return async () => ({ nats: await passes(() => deps.nc.rtt()) })
}
