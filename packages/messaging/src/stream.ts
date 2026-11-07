import {
  JetStreamApiCodes,
  JetStreamApiError,
  RetentionPolicy,
  StorageType,
  type JetStreamManager,
  type StreamConfig,
  type StreamInfo,
} from '@nats-io/jetstream'
import { nanos } from '@nats-io/transport-node'

export const LOGISTICS_STREAM = {
  name: 'LOGISTICS_EVENTS',
  subjects: ['logistics.>'],
  storage: StorageType.File,
  retention: RetentionPolicy.Limits,
  // Publishes with the same msgID (= eventId) within this window are dropped
  // as duplicates. Set explicitly instead of relying on the server default.
  duplicate_window: nanos(2 * 60 * 1000),
  // 0 = no age limit: events are kept, not expired.
  max_age: 0,
} satisfies Partial<StreamConfig> & { name: string }

/**
 * Creates the stream if it is missing, otherwise updates it to the declared
 * config. Safe to call repeatedly, e.g. on every service start.
 */
export async function ensureStream(jsm: JetStreamManager): Promise<StreamInfo> {
  try {
    await jsm.streams.info(LOGISTICS_STREAM.name)
  } catch (err) {
    if (isApiError(err, JetStreamApiCodes.StreamNotFound)) {
      return jsm.streams.add(LOGISTICS_STREAM)
    }
    throw err
  }
  return jsm.streams.update(LOGISTICS_STREAM.name, LOGISTICS_STREAM)
}

export function isApiError(err: unknown, code: number): boolean {
  return err instanceof JetStreamApiError && err.code === code
}
