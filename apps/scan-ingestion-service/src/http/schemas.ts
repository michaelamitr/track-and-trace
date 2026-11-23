import { EventEnvelopeSchema } from '@tt/contracts'
import { errorBodySchema } from '@tt/http'
import { z } from 'zod'
import { SCAN_TYPES } from '../domain/scan.js'

// Field rules are taken from @tt/contracts where the event has the same field,
// so the API cannot accept a value the event would reject. UUIDs are accepted
// in any letter case here; the domain lowercases them (normalizeScan).
const envelope = EventEnvelopeSchema.shape

export const ScanBodySchema = z.object({
  eventId: envelope.eventId.meta({
    description: 'UUID assigned by the scanner. A retried scan must reuse it. Any letter case.',
    example: '4d36957b-6c2b-47e0-b784-13a9b00c0b67',
  }),
  shipmentId: envelope.shipmentId.meta({ description: 'UUID. Any letter case.' }),
  type: z.enum(SCAN_TYPES),
  // ISO 8601 UTC with the Z suffix; offsets such as +01:00 are rejected.
  occurredAt: envelope.occurredAt.meta({
    description: 'ISO 8601 UTC with the Z suffix, at most 5 minutes in the future.',
    example: '2026-10-28T09:30:00Z',
  }),
  facilityId: z.string().min(1).max(64),
  scannerId: z.string().min(1).max(64),
})

export type ScanBody = z.infer<typeof ScanBodySchema>

export const ScanAcceptedResponseSchema = z.object({ eventId: z.uuid() })

export const ErrorBodySchema = errorBodySchema()
