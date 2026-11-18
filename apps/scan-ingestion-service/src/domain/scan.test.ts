import { LogisticsEventSchema } from '@tt/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildScanEvent,
  eventTypeForScan,
  isOccurredAtTooFarInFuture,
  normalizeScan,
  SCAN_TYPES,
  UnknownScanTypeError,
  type ScanRequest,
} from './scan.js'

const scan: ScanRequest = {
  eventId: '4d36957b-6c2b-47e0-b784-13a9b00c0b67',
  shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4',
  type: 'ARRIVED_AT_HUB',
  occurredAt: '2026-10-28T09:30:00Z',
  facilityId: 'DEPOT-BRNO',
  scannerId: 'SCANNER-17',
}

describe('eventTypeForScan', () => {
  it.each([
    ['ACCEPTED', 'parcel.accepted'],
    ['ARRIVED_AT_HUB', 'parcel.arrived_at_hub'],
    ['OUT_FOR_DELIVERY', 'parcel.out_for_delivery'],
    ['DELIVERED', 'parcel.delivered'],
  ])('maps %s to %s', (type, eventType) => {
    expect(eventTypeForScan(type)).toBe(eventType)
  })

  it('has a mapping for every scan type', () => {
    expect(SCAN_TYPES.map(eventTypeForScan)).toHaveLength(4)
  })

  it.each(['RETURNED', 'delivered', 'parcel.delivered', '', 'toString', '__proto__'])(
    'rejects the unknown type "%s"',
    (type) => {
      expect(() => eventTypeForScan(type)).toThrow(UnknownScanTypeError)
    },
  )
})

describe('normalizeScan', () => {
  it('lowercases eventId and shipmentId and keeps everything else', () => {
    const upper = {
      ...scan,
      eventId: '4D36957B-6C2B-47E0-B784-13A9B00C0B67',
      shipmentId: '0D40C8BB-E48F-4311-9223-1A54A7E197E4',
      facilityId: 'Depot-Brno',
    }

    expect(normalizeScan(upper)).toEqual({ ...scan, facilityId: 'Depot-Brno' })
  })

  it('leaves lowercase ids unchanged', () => {
    expect(normalizeScan(scan)).toEqual(scan)
  })
})

describe('isOccurredAtTooFarInFuture', () => {
  const now = new Date('2026-10-28T09:30:00.000Z')

  it.each([
    ['exactly 5 minutes ahead', '2026-10-28T09:35:00.000Z', false],
    ['4 min 59.999 s ahead', '2026-10-28T09:34:59.999Z', false],
    ['equal to now', '2026-10-28T09:30:00Z', false],
    ['one second in the past', '2026-10-28T09:29:59Z', false],
    ['a year in the past', '2025-10-28T09:30:00Z', false],
    ['5 min 1 ms ahead', '2026-10-28T09:35:00.001Z', true],
    ['an hour ahead', '2026-10-28T10:30:00Z', true],
  ])('%s -> %s', (_label, occurredAt, tooFar) => {
    expect(isOccurredAtTooFarInFuture(occurredAt, now)).toBe(tooFar)
  })

  it('uses the given now, not the system clock', () => {
    // Far in the future compared to the real clock, but only 5 minutes after `now`.
    const later = new Date('2099-01-01T00:00:00Z')
    expect(isOccurredAtTooFarInFuture('2099-01-01T00:05:00Z', later)).toBe(false)
    expect(isOccurredAtTooFarInFuture('2099-01-01T00:05:00.001Z', later)).toBe(true)
  })
})

describe('buildScanEvent', () => {
  const receivedAt = new Date('2026-10-28T09:31:12Z')

  it('builds the event of the API example', () => {
    expect(buildScanEvent(scan, receivedAt)).toEqual({
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
    })
  })

  it('keeps milliseconds of receivedAt', () => {
    expect(buildScanEvent(scan, new Date('2026-10-28T09:31:12.345Z')).receivedAt).toBe('2026-10-28T09:31:12.345Z')
  })

  it.each(SCAN_TYPES)('builds a valid LogisticsEvent for %s', (type) => {
    const event = buildScanEvent({ ...scan, type }, receivedAt)

    expect(event.eventType).toBe(eventTypeForScan(type))
    expect(LogisticsEventSchema.parse(event)).toEqual(event)
  })
})
