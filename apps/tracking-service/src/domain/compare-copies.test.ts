import { EventEnvelopeSchema, LogisticsEventSchema, type ShipmentRegisteredEvent } from '@tt/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { differingFields, TIME_FIELDS } from './compare-copies.js'
import type { TrackingEvent } from './shipment-status.js'

type ScanEvent = Exclude<TrackingEvent, ShipmentRegisteredEvent>

const scan: ScanEvent = {
  eventId: '4d36957b-6c2b-47e0-b784-13a9b00c0b67',
  eventType: 'parcel.arrived_at_hub',
  eventVersion: 1,
  shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
  occurredAt: '2026-10-28T09:30:00Z',
  receivedAt: '2026-10-28T09:31:12Z',
  correlationId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
  causationId: null,
  producer: 'scan-ingestion',
  data: { facilityId: 'DEPOT-BRNO', scannerId: 'SCANNER-17' },
}

const registered: ShipmentRegisteredEvent = {
  ...scan,
  eventType: 'shipment.registered',
  producer: 'shipment',
  data: {
    trackingNumber: 'PF-0001',
    originFacilityId: 'DEPOT-PRAHA',
    destination: 'Brno',
    recipientId: 'CUST-42',
    expectedDeliveryAt: '2026-10-29T16:00:00Z',
  },
}

const OTHER_ID = '9a1e2b3c-4d5e-4f60-8a7b-6c5d4e3f2a1b'

describe('differingFields', () => {
  it('is empty for identical copies', () => {
    expect(differingFields(scan, structuredClone(scan))).toEqual([])
    expect(differingFields(registered, structuredClone(registered))).toEqual([])
  })

  it('ignores receivedAt', () => {
    expect(differingFields(scan, { ...scan, receivedAt: '2026-10-28T11:00:00Z' })).toEqual([])
  })

  it('does not depend on the key order (jsonb does not keep it)', () => {
    const reordered = Object.fromEntries(Object.entries(scan).reverse()) as ScanEvent
    reordered.data = { scannerId: 'SCANNER-17', facilityId: 'DEPOT-BRNO' }

    expect(differingFields(scan, reordered)).toEqual([])
  })

  it.each(['2026-10-28T09:30:00.000Z', '2026-10-28T09:30:00.0Z'])('treats occurredAt %s as the same instant', (occurredAt) => {
    expect(LogisticsEventSchema.safeParse({ ...scan, occurredAt }).success).toBe(true)
    expect(differingFields(scan, { ...scan, occurredAt })).toEqual([])
  })

  it('compares times in data as instants', () => {
    const copy = (expectedDeliveryAt: string) => ({ ...registered, data: { ...registered.data, expectedDeliveryAt } })

    expect(differingFields(registered, copy('2026-10-29T16:00:00.000Z'))).toEqual([])
    expect(differingFields(registered, copy('2026-10-29T16:00:00.001Z'))).toEqual(['data.expectedDeliveryAt'])
  })

  it.each([
    ['occurredAt', { occurredAt: '2026-10-28T09:30:00.001Z' }],
    ['shipmentId', { shipmentId: OTHER_ID }],
    ['correlationId', { correlationId: OTHER_ID }],
    ['causationId', { causationId: OTHER_ID }],
    ['eventType', { eventType: 'parcel.delivered' }],
    ['data.facilityId', { data: { ...scan.data, facilityId: 'DEPOT-OSTRAVA' } }],
    ['data.scannerId', { data: { ...scan.data, scannerId: 'SCANNER-18' } }],
  ] as const)('names a different %s, in both directions', (field, change) => {
    const copy = { ...scan, ...change } as ScanEvent

    expect(differingFields(scan, copy)).toEqual([field])
    expect(differingFields(copy, scan)).toEqual([field])
  })

  it('compares text exactly, even if it looks like the same time', () => {
    const a = { ...registered, data: { ...registered.data, destination: '2026-10-29T16:00:00Z' } }
    const b = { ...registered, data: { ...registered.data, destination: '2026-10-29T16:00:00.000Z' } }

    expect(differingFields(a, b)).toEqual(['data.destination'])
    expect(differingFields(scan, { ...scan, data: { ...scan.data, facilityId: 'depot-brno' } })).toEqual([
      'data.facilityId',
    ])
  })

  it('lists every differing field, sorted', () => {
    const copy: ScanEvent = {
      ...scan,
      occurredAt: '2026-10-28T10:00:00Z',
      shipmentId: OTHER_ID,
      data: { facilityId: 'DEPOT-OSTRAVA', scannerId: 'SCANNER-18' },
    }

    expect(differingFields(scan, copy)).toEqual(['data.facilityId', 'data.scannerId', 'occurredAt', 'shipmentId'])
  })

  it('lists fields that only one copy has when the event types differ', () => {
    expect(differingFields(scan, registered)).toEqual([
      'data.destination',
      'data.expectedDeliveryAt',
      'data.facilityId',
      'data.originFacilityId',
      'data.recipientId',
      'data.scannerId',
      'data.trackingNumber',
      'eventType',
      'producer',
    ])
  })
})

describe('TIME_FIELDS', () => {
  /** Names of the properties a schema declares as a date-time. */
  function timeProperties(schema: z.ZodType): string[] {
    const { properties = {} } = z.toJSONSchema(schema) as { properties?: Record<string, { format?: string }> }
    return Object.entries(properties)
      .filter(([, property]) => property.format === 'date-time')
      .map(([name]) => name)
  }

  it('is every time field of the events Tracking consumes, except receivedAt', () => {
    const consumed = LogisticsEventSchema.options.filter((schema) => schema.shape.eventType.value !== 'sla.breached')
    expect(consumed).toHaveLength(5)

    const expected = new Set([
      ...timeProperties(EventEnvelopeSchema).filter((name) => name !== 'receivedAt'),
      ...consumed.flatMap((schema) => timeProperties(schema.shape.data).map((name) => `data.${name}`)),
    ])

    expect(TIME_FIELDS).toEqual(expected)
  })
})
