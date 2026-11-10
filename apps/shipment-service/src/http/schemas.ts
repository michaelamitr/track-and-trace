import { ShipmentRegisteredDataSchema } from '@tt/contracts'
import { z } from 'zod'

// Field rules are taken from @tt/contracts where the event has the same field,
// so the API cannot accept a value the event would reject.
const event = ShipmentRegisteredDataSchema.shape

export const RegisterShipmentBodySchema = z.object({
  orderReference: z.string().min(1).max(64).meta({ description: "The e-shop's own order number. Unique." }),
  originFacilityId: event.originFacilityId,
  destination: event.destination,
  recipientId: event.recipientId,
  // ISO 8601 UTC with the Z suffix; offsets such as +01:00 are rejected.
  expectedDeliveryAt: event.expectedDeliveryAt.meta({
    description: 'ISO 8601 UTC with the Z suffix, e.g. 2026-11-11T16:00:00Z.',
    example: '2026-11-11T16:00:00Z',
  }),
})

export type RegisterShipmentBody = z.infer<typeof RegisterShipmentBodySchema>

export const ShipmentResponseSchema = z.object({
  shipmentId: z.uuid(),
  trackingNumber: z.string(),
  orderReference: z.string(),
  originFacilityId: z.string(),
  destination: z.string(),
  recipientId: z.string(),
  expectedDeliveryAt: z.iso.datetime(),
})

export type ShipmentResponse = z.infer<typeof ShipmentResponseSchema>

export const ShipmentParamsSchema = z.object({
  shipmentId: z.uuid(),
})

export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'NOT_FOUND',
  'ORDER_CONFLICT',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
])

export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export const ErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
})

export type ErrorBody = z.infer<typeof ErrorBodySchema>

export const LiveResponseSchema = z.object({ status: z.literal('ok') })

const CheckSchema = z.enum(['ok', 'failed'])

export const ReadyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({ database: CheckSchema, nats: CheckSchema }),
})
