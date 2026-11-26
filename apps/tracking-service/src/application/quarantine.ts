import { translateDatabaseError } from '@tt/db'
import type { QuarantineReason, QuarantineRecord } from '@tt/messaging'
import type pg from 'pg'
import { findQuarantined, insertQuarantined, type QuarantinedMessage } from '../db/quarantine.js'

/** Writes to quarantined_events; passed to consumeEvents, which retries every failure. */
export type Quarantine = (record: QuarantineRecord) => Promise<void>

export type ListQuarantine = (filter: { reason?: QuarantineReason | undefined; limit: number }) => Promise<
  QuarantinedMessage[]
>

export function createQuarantine(deps: { pool: pg.Pool }): Quarantine {
  return async function quarantine(record) {
    try {
      await insertQuarantined(deps.pool, record)
    } catch (err) {
      throw translateDatabaseError(err)
    }
  }
}

export function createListQuarantine(deps: { pool: pg.Pool }): ListQuarantine {
  return async function listQuarantine(filter) {
    try {
      return await findQuarantined(deps.pool, filter)
    } catch (err) {
      throw translateDatabaseError(err)
    }
  }
}
