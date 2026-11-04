import { z } from 'zod'

export const ShipmentRegisteredDataSchema = z.object({
  trackingNumber: z.string().min(1),
  originFacilityId: z.string().min(1),
  destination: z.string().min(1),
  recipientId: z.string().min(1),
  expectedDeliveryAt: z.iso.datetime(),
})

export const ScanDataSchema = z.object({
  facilityId: z.string().min(1),
  scannerId: z.string().min(1),
})

export const SlaBreachReasonSchema = z.enum(['NOT_DELIVERED_IN_TIME', 'DELIVERED_LATE'])

export const SlaBreachedDataSchema = z.object({
  incidentId: z.uuid(),
  expectedDeliveryAt: z.iso.datetime(),
  effectiveDeadline: z.iso.datetime(),
  reason: SlaBreachReasonSchema,
  deliveredAt: z.iso.datetime().nullable(),
})

export type ShipmentRegisteredData = z.infer<typeof ShipmentRegisteredDataSchema>
export type ScanData = z.infer<typeof ScanDataSchema>
export type SlaBreachedData = z.infer<typeof SlaBreachedDataSchema>