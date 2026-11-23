import { ShipmentRegisteredDataSchema } from '@tt/contracts'
import { errorBodySchema } from '@tt/http'
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

/** Error codes of this service, besides the shared ones of @tt/http. */
export const OWN_ERROR_CODES = ['ORDER_CONFLICT'] as const

export type OwnErrorCode = (typeof OWN_ERROR_CODES)[number]

export const ErrorBodySchema = errorBodySchema(OWN_ERROR_CODES)
