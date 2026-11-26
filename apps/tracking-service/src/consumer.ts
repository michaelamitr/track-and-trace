import type { JetStreamClient } from '@nats-io/jetstream'
import { DatabaseUnavailableError } from '@tt/db'
import { consumeEvents, type ConsumeHandle, type ConsumerLogger, type ConsumerTiming } from '@tt/messaging'
import type pg from 'pg'
import { createEventHandler, type HandlerLogger } from './application/handle-event.js'
import { createProcessEvent } from './application/process-event.js'
import { createQuarantine } from './application/quarantine.js'

/**
 * Tracking's classification (ADR-0015 rule 1): only an unavailable database is
 * transient, which includes a statement over its time limit and a pool that
 * gives no connection in time (@tt/db translates all of them). Every other
 * error is permanent, such as an event Tracking does not consume or a stream
 * sequence stored with another event.
 */
export function isTransient(err: unknown): boolean {
  return err instanceof DatabaseUnavailableError
}

/** The "tracking" consumer as main.ts runs it; tests pass shorter delays. */
export function startTrackingConsumer(deps: {
  js: JetStreamClient
  pool: pg.Pool
  log: HandlerLogger & ConsumerLogger
  timing?: Partial<ConsumerTiming>
}): Promise<ConsumeHandle> {
  return consumeEvents(deps.js, 'tracking', {
    handler: createEventHandler({ processEvent: createProcessEvent({ pool: deps.pool }), log: deps.log }),
    isTransient,
    quarantine: createQuarantine({ pool: deps.pool }),
    log: deps.log,
    ...(deps.timing ? { timing: deps.timing } : {}),
  })
}
