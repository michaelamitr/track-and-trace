import { JetStreamApiCodes, type JetStreamManager } from '@nats-io/jetstream'
import { CONSUMERS, ensureConsumer, type ConsumerName } from './consumers.js'
import { ensureStream, isApiError, LOGISTICS_STREAM } from './stream.js'

const SETUP_HINT = 'Run `pnpm nats:setup` first.'

/**
 * Creates or updates the stream and every durable consumer to the declared
 * config. Run by the setup step (`pnpm nats:setup`), not by services.
 */
export async function setupNats(jsm: JetStreamManager): Promise<void> {
  await ensureStream(jsm)
  for (const name of Object.keys(CONSUMERS) as ConsumerName[]) {
    await ensureConsumer(jsm, name)
  }
}

/** Read-only check for services at startup: throws if the stream is missing. */
export async function verifyStream(jsm: JetStreamManager): Promise<void> {
  try {
    await jsm.streams.info(LOGISTICS_STREAM.name)
  } catch (err) {
    if (isApiError(err, JetStreamApiCodes.StreamNotFound)) {
      throw new Error(`Stream ${LOGISTICS_STREAM.name} not found. ${SETUP_HINT}`, { cause: err })
    }
    throw err
  }
}

// The settings the failure handling of consumeEvents relies on (ADR-0015).
const VERIFIED_SETTINGS = ['max_deliver', 'ack_wait'] as const

/**
 * Read-only check for services at startup: throws if the durable consumer
 * (or the stream it belongs to) is missing, or if its max_deliver or ack_wait
 * differ from the declared config (an older setup).
 */
export async function verifyConsumer(jsm: JetStreamManager, name: ConsumerName): Promise<void> {
  let info
  try {
    info = await jsm.consumers.info(LOGISTICS_STREAM.name, name)
  } catch (err) {
    if (
      isApiError(err, JetStreamApiCodes.ConsumerNotFound) ||
      isApiError(err, JetStreamApiCodes.StreamNotFound)
    ) {
      throw new Error(
        `Consumer ${name} on stream ${LOGISTICS_STREAM.name} not found. ${SETUP_HINT}`,
        { cause: err },
      )
    }
    throw err
  }
  const differences = VERIFIED_SETTINGS.filter((key) => info.config[key] !== CONSUMERS[name][key]).map(
    (key) => `${key} is ${info.config[key]}, expected ${CONSUMERS[name][key]}`,
  )
  if (differences.length > 0) {
    throw new Error(
      `Consumer ${name} on stream ${LOGISTICS_STREAM.name} has an outdated config (${differences.join(', ')}). ${SETUP_HINT}`,
    )
  }
}
