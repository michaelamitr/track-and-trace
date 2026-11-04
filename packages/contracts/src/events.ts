import { z } from 'zod'
import { EventEnvelopeSchema } from './envelope.js'
import {
  ScanDataSchema,
  ShipmentRegisteredDataSchema,
  SlaBreachedDataSchema,
} from './payloads.js'

// All schemas in this file describe version 1 of the contract.
const EnvelopeV1 = EventEnvelopeSchema.extend({
  eventVersion: z.literal(1),
})

export const ShipmentRegisteredEventSchema = EnvelopeV1.extend({
  eventType: z.literal('shipment.registered'),
  producer: z.literal('shipment'),
  data: ShipmentRegisteredDataSchema,
})

export const ParcelAcceptedEventSchema = EnvelopeV1.extend({
  eventType: z.literal('parcel.accepted'),
  producer: z.literal('scan-ingestion'),
  data: ScanDataSchema,
})

export const ParcelArrivedAtHubEventSchema = EnvelopeV1.extend({
  eventType: z.literal('parcel.arrived_at_hub'),
  producer: z.literal('scan-ingestion'),
  data: ScanDataSchema,
})

export const ParcelOutForDeliveryEventSchema = EnvelopeV1.extend({
  eventType: z.literal('parcel.out_for_delivery'),
  producer: z.literal('scan-ingestion'),
  data: ScanDataSchema,
})

export const ParcelDeliveredEventSchema = EnvelopeV1.extend({
  eventType: z.literal('parcel.delivered'),
  producer: z.literal('scan-ingestion'),
  data: ScanDataSchema,
})

export const SlaBreachedEventSchema = EnvelopeV1.extend({
  eventType: z.literal('sla.breached'),
  producer: z.literal('sla-monitoring'),
  data: SlaBreachedDataSchema,
})

export const LogisticsEventSchema = z.discriminatedUnion('eventType', [
  ShipmentRegisteredEventSchema,
  ParcelAcceptedEventSchema,
  ParcelArrivedAtHubEventSchema,
  ParcelOutForDeliveryEventSchema,
  ParcelDeliveredEventSchema,
  SlaBreachedEventSchema,
])

export type LogisticsEvent = z.infer<typeof LogisticsEventSchema>
export type ShipmentRegisteredEvent = z.infer<typeof ShipmentRegisteredEventSchema>
export type SlaBreachedEvent = z.infer<typeof SlaBreachedEventSchema>