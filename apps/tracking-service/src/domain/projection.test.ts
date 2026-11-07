import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { project } from './projection.js'
import type { TrackingEvent } from './shipment-status.js'

const SHIPMENT_ID = '0d40c8bb-e48f-4311-9223-1a54a7e197e4'
const CORRELATION_ID = 'a1e8c78c-931b-4d11-a88f-38a26d4d8e17'

type ScanType = Exclude<TrackingEvent['eventType'], 'shipment.registered'>

type ScanOptions = {
  eventId?: string
  facilityId?: string
  receivedAt?: string
}

function registered(occurredAt: string, eventId: string = randomUUID()): TrackingEvent {
  return {
    eventId,
    eventType: 'shipment.registered',
    eventVersion: 1,
    shipmentId: SHIPMENT_ID,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: CORRELATION_ID,
    causationId: null,
    producer: 'shipment',
    data: {
      trackingNumber: 'PF-0001',
      originFacilityId: 'DEPOT-PRAHA',
      destination: 'Brno',
      recipientId: 'CUST-42',
      expectedDeliveryAt: '2026-10-29T16:00:00Z',
    },
  }
}

function scan(eventType: ScanType, occurredAt: string, options: ScanOptions = {}): TrackingEvent {
  return {
    eventId: options.eventId ?? randomUUID(),
    eventType,
    eventVersion: 1,
    shipmentId: SHIPMENT_ID,
    occurredAt,
    receivedAt: options.receivedAt ?? occurredAt,
    correlationId: CORRELATION_ID,
    causationId: null,
    producer: 'scan-ingestion',
    data: {
      facilityId: options.facilityId ?? 'DEPOT-BRNO',
      scannerId: 'SCANNER-17',
    },
  }
}

describe('project', () => {
  it('normal journey: ends as DELIVERED with the full history', () => {
    const result = project([
      registered('2026-10-28T08:00:00Z'),
      scan('parcel.accepted', '2026-10-28T08:15:00Z', { facilityId: 'DEPOT-PRAHA' }),
      scan('parcel.arrived_at_hub', '2026-10-28T09:30:00Z'),
      scan('parcel.out_for_delivery', '2026-10-28T12:00:00Z'),
      scan('parcel.delivered', '2026-10-28T14:00:00Z'),
    ])

    expect(result.status).toBe('DELIVERED')
    expect(result.deliveredAt).toBe('2026-10-28T14:00:00Z')
    expect(result.history).toHaveLength(5)
  })

  it('R1: counts the same event passed twice only once', () => {
    const accepted = scan('parcel.accepted', '2026-10-28T08:15:00Z')

    const result = project([accepted, accepted])

    expect(result.history.map((entry) => entry.eventId)).toEqual([accepted.eventId])
  })

  it('R1: keeps the earliest receivedAt of a retried event, in both input orders', () => {
    const eventId = randomUUID()
    const firstCopy = scan('parcel.delivered', '2026-10-28T14:00:00Z', {
      eventId,
      receivedAt: '2026-10-28T14:01:00Z',
    })
    // As a string this later receivedAt sorts first, so it has to be compared as a timestamp.
    const retry = scan('parcel.delivered', '2026-10-28T14:00:00Z', {
      eventId,
      receivedAt: '2026-10-28T14:01:00.500Z',
    })

    for (const events of [[firstCopy, retry], [retry, firstCopy]]) {
      const { history } = project(events)

      expect(history.map((entry) => entry.receivedAt)).toEqual(['2026-10-28T14:01:00Z'])
      expect(history.map((entry) => entry.isAnomaly)).toEqual([false])
    }
  })

  it('R1: keeps the code-unit smaller receivedAt when both copies are the same instant', () => {
    const eventId = randomUUID()
    // The same instant written two ways. As code units "." sorts before "Z", so .000Z is kept.
    const plain = scan('parcel.delivered', '2026-10-28T14:00:00Z', {
      eventId,
      receivedAt: '2026-10-28T14:01:00Z',
    })
    const withMillis = scan('parcel.delivered', '2026-10-28T14:00:00Z', {
      eventId,
      receivedAt: '2026-10-28T14:01:00.000Z',
    })

    for (const events of [[plain, withMillis], [withMillis, plain]]) {
      const { history } = project(events)

      expect(history.map((entry) => entry.receivedAt)).toEqual(['2026-10-28T14:01:00.000Z'])
    }
  })

  it('R2/R6: orders by occurredAt when the delivery arrives before an earlier scan', () => {
    const result = project([
      scan('parcel.delivered', '2026-10-28T14:00:00Z'),
      scan('parcel.arrived_at_hub', '2026-10-28T09:30:00Z'),
    ])

    expect(result.status).toBe('DELIVERED')
    expect(result.history.map((entry) => entry.eventType)).toEqual([
      'parcel.arrived_at_hub',
      'parcel.delivered',
    ])
    expect(result.history.map((entry) => entry.isAnomaly)).toEqual([false, false])
  })

  it('R2: orders events with the same occurredAt by lifecycle phase', () => {
    // The eventIds contradict the phase order, so the eventId tie-breaker cannot pass this by luck.
    const result = project([
      scan('parcel.delivered', '2026-10-28T14:00:00Z', {
        eventId: '11111111-1111-4111-8111-111111111111',
      }),
      scan('parcel.out_for_delivery', '2026-10-28T14:00:00Z', {
        eventId: '22222222-2222-4222-8222-222222222222',
      }),
    ])

    expect(result.history.map((entry) => entry.eventType)).toEqual([
      'parcel.out_for_delivery',
      'parcel.delivered',
    ])
  })

  it('R2: orders events with the same occurredAt and phase by eventId', () => {
    const lowerId = '11111111-1111-4111-8111-111111111111'
    const higherId = '22222222-2222-4222-8222-222222222222'

    const result = project([
      scan('parcel.arrived_at_hub', '2026-10-28T09:30:00Z', { eventId: higherId }),
      scan('parcel.arrived_at_hub', '2026-10-28T09:30:00Z', { eventId: lowerId }),
    ])

    expect(result.history.map((entry) => entry.eventId)).toEqual([lowerId, higherId])
  })

  it('R2: orders eventIds by code unit, not by locale', () => {
    // Code units put uppercase letters first, while localeCompare puts "a" before "B".
    const uppercaseId = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'
    const lowercaseId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    const result = project([
      scan('parcel.arrived_at_hub', '2026-10-28T09:30:00Z', { eventId: lowercaseId }),
      scan('parcel.arrived_at_hub', '2026-10-28T09:30:00Z', { eventId: uppercaseId }),
    ])

    expect(result.history.map((entry) => entry.eventId)).toEqual([uppercaseId, lowercaseId])
  })

  it('R2: compares occurredAt as parsed timestamps, not as strings', () => {
    // As strings, .500Z sorts before :00Z. The later event also has the lower lifecycle phase,
    // so ignoring the fraction and falling back to the phase tie-breaker fails as well.
    const result = project([
      scan('parcel.arrived_at_hub', '2026-10-28T09:30:00.500Z'),
      scan('parcel.out_for_delivery', '2026-10-28T09:30:00Z'),
    ])

    expect(result.history.map((entry) => entry.eventType)).toEqual([
      'parcel.out_for_delivery',
      'parcel.arrived_at_hub',
    ])
    expect(result.status).toBe('AT_HUB')
    expect(result.lastEventAt).toBe('2026-10-28T09:30:00.500Z')
  })

  it('R3: returns from OUT_FOR_DELIVERY to AT_HUB after a failed delivery attempt', () => {
    const result = project([
      scan('parcel.out_for_delivery', '2026-10-28T12:00:00Z', { facilityId: 'DEPOT-BRNO' }),
      scan('parcel.arrived_at_hub', '2026-10-28T15:00:00Z', { facilityId: 'HUB-OLOMOUC' }),
    ])

    expect(result.status).toBe('AT_HUB')
    expect(result.lastEventAt).toBe('2026-10-28T15:00:00Z')
    expect(result.lastLocation).toBe('HUB-OLOMOUC')
  })

  it('R4/R5: keeps the first delivery final and marks later events as anomalies', () => {
    const result = project([
      scan('parcel.delivered', '2026-10-28T14:00:00Z', {
        facilityId: 'DEPOT-BRNO',
        receivedAt: '2026-10-28T14:05:00Z',
      }),
      scan('parcel.accepted', '2026-10-28T15:00:00Z', { facilityId: 'DEPOT-PRAHA' }),
      scan('parcel.delivered', '2026-10-28T16:00:00Z', { facilityId: 'HUB-OLOMOUC' }),
    ])

    expect(result.status).toBe('DELIVERED')
    expect(result.deliveredAt).toBe('2026-10-28T14:00:00Z')
    expect(result.lastEventAt).toBe('2026-10-28T14:00:00Z')
    expect(result.lastLocation).toBe('DEPOT-BRNO')
    expect(result.history.map((entry) => entry.eventType)).toEqual([
      'parcel.delivered',
      'parcel.accepted',
      'parcel.delivered',
    ])
    expect(result.history.map((entry) => entry.isAnomaly)).toEqual([false, true, true])
  })

  it('R6: a scan that happened before the delivery but arrived after it is not an anomaly', () => {
    const result = project([
      scan('parcel.delivered', '2026-10-28T14:00:00Z'),
      scan('parcel.arrived_at_hub', '2026-10-28T13:00:00Z', {
        receivedAt: '2026-10-28T15:00:00Z',
      }),
    ])

    expect(result.status).toBe('DELIVERED')
    expect(result.history.map((entry) => entry.eventType)).toEqual([
      'parcel.arrived_at_hub',
      'parcel.delivered',
    ])
    expect(result.history.map((entry) => entry.isAnomaly)).toEqual([false, false])
  })

  it('output: lastLocation is null when the only event is shipment.registered', () => {
    const result = project([registered('2026-10-28T08:00:00Z')])

    expect(result.status).toBe('REGISTERED')
    expect(result.lastEventAt).toBe('2026-10-28T08:00:00Z')
    expect(result.lastLocation).toBeNull()
  })

  it('output: history entries carry status, occurredAt, receivedAt and facilityId', () => {
    const result = project([
      registered('2026-10-28T08:00:00Z'),
      scan('parcel.accepted', '2026-10-28T08:15:00Z', {
        facilityId: 'DEPOT-PRAHA',
        receivedAt: '2026-10-28T08:16:00Z',
      }),
      scan('parcel.arrived_at_hub', '2026-10-28T09:30:00Z', {
        facilityId: 'HUB-OLOMOUC',
        receivedAt: '2026-10-28T09:31:00Z',
      }),
      scan('parcel.out_for_delivery', '2026-10-28T12:00:00Z', {
        facilityId: 'DEPOT-BRNO',
        receivedAt: '2026-10-28T12:01:00Z',
      }),
      scan('parcel.delivered', '2026-10-28T14:00:00Z', {
        facilityId: 'PICKUP-BRNO',
        receivedAt: '2026-10-28T14:01:00Z',
      }),
      // An anomaly keeps the status of its own event type.
      scan('parcel.accepted', '2026-10-28T15:00:00Z', {
        facilityId: 'DEPOT-OSTRAVA',
        receivedAt: '2026-10-28T15:01:00Z',
      }),
    ])

    expect(
      result.history.map(({ status, occurredAt, receivedAt, facilityId }) => ({
        status,
        occurredAt,
        receivedAt,
        facilityId,
      })),
    ).toEqual([
      {
        status: 'REGISTERED',
        occurredAt: '2026-10-28T08:00:00Z',
        receivedAt: '2026-10-28T08:00:00Z',
        facilityId: null,
      },
      {
        status: 'ACCEPTED',
        occurredAt: '2026-10-28T08:15:00Z',
        receivedAt: '2026-10-28T08:16:00Z',
        facilityId: 'DEPOT-PRAHA',
      },
      {
        status: 'AT_HUB',
        occurredAt: '2026-10-28T09:30:00Z',
        receivedAt: '2026-10-28T09:31:00Z',
        facilityId: 'HUB-OLOMOUC',
      },
      {
        status: 'OUT_FOR_DELIVERY',
        occurredAt: '2026-10-28T12:00:00Z',
        receivedAt: '2026-10-28T12:01:00Z',
        facilityId: 'DEPOT-BRNO',
      },
      {
        status: 'DELIVERED',
        occurredAt: '2026-10-28T14:00:00Z',
        receivedAt: '2026-10-28T14:01:00Z',
        facilityId: 'PICKUP-BRNO',
      },
      {
        status: 'ACCEPTED',
        occurredAt: '2026-10-28T15:00:00Z',
        receivedAt: '2026-10-28T15:01:00Z',
        facilityId: 'DEPOT-OSTRAVA',
      },
    ])
  })

  it('determinism: gives equal results for original, reversed and shuffled input', () => {
    const registration = registered('2026-10-28T08:00:00Z')
    const accepted = scan('parcel.accepted', '2026-10-28T08:15:00Z')
    const hubA = scan('parcel.arrived_at_hub', '2026-10-28T09:30:00Z')
    const hubB = scan('parcel.arrived_at_hub', '2026-10-28T09:30:00Z')
    const outForDelivery = scan('parcel.out_for_delivery', '2026-10-28T14:00:00Z')
    const delivered = scan('parcel.delivered', '2026-10-28T14:00:00Z')
    const anomaly = scan('parcel.accepted', '2026-10-28T15:00:00Z')

    const original = [registration, accepted, hubA, hubB, outForDelivery, delivered, anomaly]
    const reversed = [...original].reverse()
    const shuffled = [hubA, anomaly, registration, delivered, hubB, accepted, outForDelivery]

    const expected = project(original)

    expect(project(reversed)).toEqual(expected)
    expect(project(shuffled)).toEqual(expected)
  })

  it('empty input: has no status and an empty history', () => {
    expect(project([])).toEqual({
      status: null,
      lastLocation: null,
      lastEventAt: null,
      deliveredAt: null,
      history: [],
    })
  })
})
