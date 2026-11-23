import { errorBodySchema } from '@tt/http'
import { z } from 'zod'
import { SHIPMENT_STATUSES } from '../domain/shipment-status.js'

const StatusSchema = z.enum(SHIPMENT_STATUSES)

/** Accepted in any letter case; lowercase from here on. */
export const ShipmentParamsSchema = z.object({
  shipmentId: z.uuid().toLowerCase(),
})

// All times are Date.toISOString().
const TimeSchema = z.iso.datetime()

export const TrackingResponseSchema = z.object({
  shipmentId: z.uuid(),
  trackingNumber: z.string(),
  status: StatusSchema,
  lastLocation: z
    .string()
    .nullable()
    .meta({ description: 'Facility of the event that determined the status; null while REGISTERED.' }),
  lastEventAt: TimeSchema.meta({ description: 'occurredAt of the event that determined the status (business time).' }),
  deliveredAt: TimeSchema.nullable().meta({ description: 'occurredAt of the first DELIVERED.' }),
  updatedAt: TimeSchema.meta({ description: 'When Tracking last processed a message of the shipment.' }),
})

export type TrackingResponse = z.infer<typeof TrackingResponseSchema>

export const HistoryEntrySchema = z.object({
  eventId: z.uuid(),
  eventType: z.string(),
  status: StatusSchema,
  occurredAt: TimeSchema,
  receivedAt: TimeSchema,
  facilityId: z.string().nullable(),
  isAnomaly: z.boolean(),
})

export type HistoryEntryResponse = z.infer<typeof HistoryEntrySchema>

export const HistoryResponseSchema = z.object({
  shipmentId: z.uuid(),
  events: z.array(HistoryEntrySchema),
})

export const AnomaliesResponseSchema = z.object({
  shipmentId: z.uuid(),
  afterDelivery: z.array(HistoryEntrySchema),
  conflicts: z.array(
    z.object({
      eventId: z.uuid(),
      streamSequence: z.int().positive(),
      receivedAt: TimeSchema,
      differingFields: z.array(z.string()),
    }),
  ),
})

export const ErrorBodySchema = errorBodySchema()
