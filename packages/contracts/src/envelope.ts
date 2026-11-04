import { z } from 'zod'

export const EVENT_TYPES = [
  'shipment.registered',
  'parcel.accepted',
  'parcel.arrived_at_hub',
  'parcel.out_for_delivery',
  'parcel.delivered',
  'sla.breached',
] as const

export const EventTypeSchema = z.enum(EVENT_TYPES)

export const ProducerSchema = z.enum(['shipment', 'scan-ingestion', 'sla-monitoring'])

export const EventEnvelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: EventTypeSchema,
  eventVersion: z.number().int().positive(),
  shipmentId: z.uuid(),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),

  correlationId: z.uuid(),
  causationId: z.uuid().nullable(),
  producer: ProducerSchema,
  data: z.unknown(),
})

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>