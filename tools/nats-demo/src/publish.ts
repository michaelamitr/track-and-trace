import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import type { LogisticsEvent } from '@tt/contracts'
import { connectNats, publishEvent, verifyStream } from '@tt/messaging'

// Fixed default so that running the script twice publishes the same event
// (and the second publish is reported as a duplicate within duplicate_window).
const DEFAULT_EVENT_ID = '6f1c2b7e-3d4a-4e5f-9a8b-1c2d3e4f5a6b'

const event: LogisticsEvent = {
  eventId: process.env.EVENT_ID ?? DEFAULT_EVENT_ID,
  eventType: 'parcel.delivered',
  eventVersion: 1,
  producer: 'scan-ingestion',
  shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
  occurredAt: '2026-10-28T09:30:00Z',
  receivedAt: '2026-10-28T09:31:12Z',
  correlationId: 'a1e8c78c-931b-4d11-a88f-38a26d4d8e17',
  causationId: null,
  data: { facilityId: 'DEPOT-BRNO', scannerId: 'SCANNER-17' },
}

const nc = await connectNats()
try {
  await verifyStream(await jetstreamManager(nc))
  const { seq, duplicate } = await publishEvent(jetstream(nc), event)
  console.log(`eventId=${event.eventId} seq=${seq} duplicate=${duplicate}`)
} finally {
  await nc.close()
}
