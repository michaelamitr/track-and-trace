import type { Consumer, JetStreamClient, JsMsg } from '@nats-io/jetstream'
import { LogisticsEventSchema, type LogisticsEvent } from '@tt/contracts'
import type { ConsumerName } from './consumers.js'
import { LOGISTICS_STREAM } from './stream.js'

// Failure handling of every consumer (ADR-0015 rules 1–5).

/** Where a message comes from; not part of the event itself. */
export type MessageMetadata = {
  /** Position in the stream: the same for every redelivery of a message, unique per published copy. */
  streamSequence: number
  subject: string
  /** 1 for the first delivery to this consumer, higher for redeliveries. */
  deliveryCount: number
}

/**
 * The handler must commit its database transaction before it resolves,
 * because the message is acked right after it resolves. Throwing leads to a
 * retry (transient error) or a redelivery (permanent error), so the handler
 * must be idempotent by eventId.
 */
export type EventHandler = (event: LogisticsEvent, metadata: MessageMetadata) => Promise<void>

export type QuarantineReason = 'INVALID' | 'PROCESSING_FAILED'

/** What the service writes to its quarantine (ADR-0015 rule 4). */
export type QuarantineRecord = {
  reason: QuarantineReason
  subject: string
  streamSequence: number
  /** The message exactly as it was received. */
  rawMessage: Uint8Array
  /** null when not known, or not a UUID. */
  eventId: string | null
  shipmentId: string | null
  /** What was wrong (INVALID) or the error text (PROCESSING_FAILED); safe to store as Postgres text. */
  details: string
}

export type ConsumerLogger = {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

/** Delays of the failure handling; the defaults are those of ADR-0015. Shorter ones are for tests. */
export type ConsumerTiming = {
  /** First wait before retrying a transient error; doubled after every failed retry. */
  retryBaseMs: number
  /** Upper limit of that wait. */
  retryMaxMs: number
  /**
   * nak delay after a permanent error on the 1st, 2nd … delivery. On the delivery
   * after the last entry (the 5th by default) the message is quarantined.
   */
  nakDelaysMs: readonly number[]
  /** How often "still working" is sent while a message is handled; well within ack_wait (30 s). */
  workingIntervalMs: number
  /** How long one pull for the next message waits on the server (at least 1000). */
  fetchExpiresMs: number
}

export const DEFAULT_CONSUMER_TIMING: ConsumerTiming = {
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  nakDelaysMs: [1_000, 5_000, 30_000, 120_000],
  workingIntervalMs: 10_000,
  fetchExpiresMs: 5_000,
}

export type ConsumeOptions = {
  handler: EventHandler
  /**
   * The service's classification (ADR-0015 rule 1): true only for an error known
   * to go away by waiting, such as an unavailable database.
   */
  isTransient(err: unknown): boolean
  /** Writes the record to the service's quarantine. Every failure is treated as transient. */
  quarantine(record: QuarantineRecord): Promise<void>
  log: ConsumerLogger
  timing?: Partial<ConsumerTiming>
}

export type ConsumeHandle = {
  /**
   * Stops taking messages and lets the message in progress finish. A message
   * waiting for a transient retry stops waiting and is naked, so it is delivered
   * again promptly after a restart. Nothing unfinished is acked.
   */
  stop(): Promise<void>
}

/** Ends waits early when the consumer stops. */
export class StopSignal {
  #stopped = false
  readonly #wakers = new Set<() => void>()

  get stopped(): boolean {
    return this.#stopped
  }

  stop(): void {
    this.#stopped = true
    for (const wake of this.#wakers) wake()
    this.#wakers.clear()
  }

  /** Resolves true after `ms`, or false as soon as the signal is stopped. */
  sleep(ms: number): Promise<boolean> {
    if (this.#stopped) return Promise.resolve(false)
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.#wakers.delete(wake)
        resolve(false)
      }
      const timer = setTimeout(() => {
        this.#wakers.delete(wake)
        resolve(true)
      }, ms)
      this.#wakers.add(wake)
    })
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Text that Postgres can store in a text column: without NUL characters and
 * without unpaired UTF-16 surrogates (replaced by U+FFFD).
 */
export function toStorableText(text: string): string {
  return text.replaceAll('\u0000', '').replace(LONE_SURROGATE, '\uFFFD')
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type Parsed =
  | { valid: true; event: LogisticsEvent }
  | { valid: false; details: string; eventId: string | null; shipmentId: string | null }

function parseMessage(msg: JsMsg): Parsed {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(msg.data))
  } catch (err) {
    return { valid: false, details: `Not JSON: ${errorText(err)}`, eventId: null, shipmentId: null }
  }
  const result = LogisticsEventSchema.safeParse(json)
  if (result.success) return { valid: true, event: result.data }
  const fields = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {}
  return {
    valid: false,
    details: result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(event)'}: ${issue.message}`)
      .join('; '),
    eventId: uuidOrNull(fields.eventId),
    shipmentId: uuidOrNull(fields.shipmentId),
  }
}

type Attempt = { result: 'done' } | { result: 'stopped' } | { result: 'permanent'; err: unknown }

/**
 * Handles one message by the rules of ADR-0015. Exported for unit tests;
 * consumeEvents calls it for every message.
 */
export async function handleMessage(
  msg: JsMsg,
  options: ConsumeOptions,
  signal: StopSignal = new StopSignal(),
): Promise<void> {
  const timing = { ...DEFAULT_CONSUMER_TIMING, ...options.timing }
  const { log } = options
  const metadata: MessageMetadata = {
    streamSequence: msg.info.streamSequence,
    subject: msg.subject,
    deliveryCount: msg.info.deliveryCount,
  }

  /**
   * Runs `action` until it succeeds, retrying transient errors in process with
   * a growing wait (rule 2). Ends early with "stopped" when the consumer stops
   * during a wait, or with "permanent" for an error that is not transient.
   */
  async function untilDone(action: () => Promise<void>, isTransient: (err: unknown) => boolean): Promise<Attempt> {
    let failures = 0
    for (;;) {
      try {
        await action()
        if (failures > 0) log.info({ ...metadata, failures }, 'message processing recovered')
        return { result: 'done' }
      } catch (err) {
        if (!isTransient(err)) return { result: 'permanent', err }
        failures += 1
        const retryInMs = Math.min(timing.retryBaseMs * 2 ** (failures - 1), timing.retryMaxMs)
        log.warn({ ...metadata, err, failures, retryInMs }, 'transient error, retrying the message')
        if (!(await signal.sleep(retryInMs))) return { result: 'stopped' }
      }
    }
  }

  function quarantine(record: Omit<QuarantineRecord, 'subject' | 'streamSequence' | 'rawMessage'>) {
    const full: QuarantineRecord = {
      ...record,
      subject: metadata.subject,
      streamSequence: metadata.streamSequence,
      rawMessage: msg.data,
      details: toStorableText(record.details),
    }
    // Rule 4: every failure to write the quarantine is transient.
    return untilDone(() => options.quarantine(full), () => true)
  }

  /** The message is delivered again soon after a restart: never ack what is not finished. */
  function nakStopped() {
    log.info(metadata, 'stopping: message not finished, naked')
    msg.nak()
  }

  // Ack wait must not expire while the message is handled, retries included.
  const working = setInterval(() => msg.working(), timing.workingIntervalMs)
  try {
    const parsed = parseMessage(msg)
    if (!parsed.valid) {
      const { details, eventId, shipmentId } = parsed
      const written = await quarantine({ reason: 'INVALID', details, eventId, shipmentId })
      if (written.result !== 'done') return nakStopped()
      log.warn({ ...metadata, eventId, details }, 'invalid message quarantined')
      msg.ack()
      return
    }

    const { event } = parsed
    const handled = await untilDone(() => options.handler(event, metadata), options.isTransient)
    if (handled.result === 'done') {
      msg.ack()
      return
    }
    if (handled.result === 'stopped') return nakStopped()

    const { err } = handled
    const fields = { ...metadata, eventId: event.eventId, err }
    const nakDelayMs = timing.nakDelaysMs[metadata.deliveryCount - 1]
    if (nakDelayMs !== undefined) {
      log.warn({ ...fields, retryInMs: nakDelayMs }, 'permanent error, message naked for a later delivery')
      msg.nak(nakDelayMs)
      return
    }
    const written = await quarantine({
      reason: 'PROCESSING_FAILED',
      details: errorText(err),
      eventId: event.eventId,
      shipmentId: event.shipmentId,
    })
    if (written.result !== 'done') return nakStopped()
    log.error(fields, 'permanent error, message quarantined')
    msg.ack()
  } finally {
    clearInterval(working)
  }
}

/** One pull: at most one message, so nothing waits in a buffer while another one is handled. */
type Fetch = Awaited<ReturnType<Consumer['fetch']>>

/**
 * Pulls messages from a durable consumer (created by setupNats) and handles
 * them strictly one at a time (ADR-0015): the next message is requested only
 * after the previous one is acked or naked, so while one message waits for the
 * database the others wait in the stream, and no ack_wait runs out meanwhile.
 */
export async function consumeEvents(
  js: JetStreamClient,
  consumerName: ConsumerName,
  options: ConsumeOptions,
): Promise<ConsumeHandle> {
  const timing = { ...DEFAULT_CONSUMER_TIMING, ...options.timing }
  const { log } = options
  const consumer = await js.consumers.get(LOGISTICS_STREAM.name, consumerName)
  const signal = new StopSignal()
  let pull: Fetch | undefined

  async function next(): Promise<JsMsg | null> {
    pull = await consumer.fetch({ max_messages: 1, expires: timing.fetchExpiresMs })
    // stop() may have come while the pull was being created.
    if (signal.stopped) pull.stop()
    try {
      for await (const msg of pull) return msg
      return null
    } finally {
      pull = undefined
    }
  }

  async function run(): Promise<void> {
    let failures = 0
    while (!signal.stopped) {
      let msg: JsMsg | null
      try {
        msg = await next()
        if (failures > 0) log.info({ consumer: consumerName, failures }, 'fetching messages recovered')
        failures = 0
      } catch (err) {
        // NATS is unavailable: try again later; the messages wait in the stream.
        failures += 1
        const retryInMs = Math.min(timing.retryBaseMs * 2 ** (failures - 1), timing.retryMaxMs)
        log.warn({ consumer: consumerName, err, failures, retryInMs }, 'fetching messages failed, will retry')
        await signal.sleep(retryInMs)
        continue
      }
      if (!msg) continue
      if (signal.stopped) {
        // Arrived while stopping; not started, so it is delivered again after a restart.
        msg.nak()
        return
      }
      try {
        await handleMessage(msg, options, signal)
      } catch (err) {
        // Only an ack or nak can throw here (NATS closed); the message is delivered again.
        log.error({ consumer: consumerName, err }, 'acknowledging a message failed')
      }
    }
  }

  const running = run().catch((err: unknown) => {
    // run() handles its errors itself; this is a bug guard.
    log.error({ consumer: consumerName, err }, 'consumer stopped unexpectedly')
  })

  return {
    async stop() {
      signal.stop()
      pull?.stop()
      await running
    },
  }
}
