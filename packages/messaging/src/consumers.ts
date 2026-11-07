import {
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  type ConsumerConfig,
  type ConsumerInfo,
  type JetStreamManager,
} from '@nats-io/jetstream'
import { nanos } from '@nats-io/transport-node'
import { SUBJECTS } from '@tt/contracts'
import { isApiError, LOGISTICS_STREAM } from './stream.js'

// Filter subjects follow the "Durable consumers" table in ARCHITECTURE.md.
const FILTER_SUBJECTS = {
  tracking: [SUBJECTS.shipmentRegistered, 'logistics.parcel.>'],
  'sla-monitoring': [SUBJECTS.shipmentRegistered, SUBJECTS.parcelDelivered],
  notification: [SUBJECTS.shipmentRegistered, SUBJECTS.parcelDelivered, SUBJECTS.slaBreached],
} as const

export type ConsumerName = keyof typeof FILTER_SUBJECTS

function consumerConfig(name: ConsumerName): Partial<ConsumerConfig> {
  return {
    durable_name: name,
    filter_subjects: [...FILTER_SUBJECTS[name]],
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    ack_wait: nanos(30_000),
    // Revisited in lesson 3.4 (retries, backoff, dead letters).
    max_deliver: 5,
  }
}

export const CONSUMERS: Record<ConsumerName, Partial<ConsumerConfig>> = {
  tracking: consumerConfig('tracking'),
  'sla-monitoring': consumerConfig('sla-monitoring'),
  notification: consumerConfig('notification'),
}

/**
 * Creates the durable consumer if it is missing, otherwise updates it to the
 * declared config. Safe to call repeatedly.
 */
export async function ensureConsumer(
  jsm: JetStreamManager,
  name: ConsumerName,
): Promise<ConsumerInfo> {
  const config = CONSUMERS[name]
  try {
    await jsm.consumers.info(LOGISTICS_STREAM.name, name)
  } catch (err) {
    if (isApiError(err, JetStreamApiCodes.ConsumerNotFound)) {
      return jsm.consumers.add(LOGISTICS_STREAM.name, config)
    }
    throw err
  }
  return jsm.consumers.update(LOGISTICS_STREAM.name, name, config)
}
