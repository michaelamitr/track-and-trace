import { describe, expect, it } from 'vitest'
import { parcel, SHIPMENT_ID } from '../test-events.js'
import { permutations } from '../test-permutations.js'
import { hasCopy, messageOutcome, resolveCopies, type ResolvedEvent, type StoredCopy } from './resolve-copies.js'
import type { TrackingEvent } from './shipment-status.js'

const OTHER_SHIPMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

const event = parcel('parcel.arrived_at_hub', '2026-10-28T09:30:00Z', { receivedAt: '2026-10-28T09:31:00.500Z' })

function copy(streamSequence: number, changes: Partial<TrackingEvent> = {}): StoredCopy {
  const changed = { ...event, ...changes } as TrackingEvent
  return { streamSequence, eventId: changed.eventId, shipmentId: changed.shipmentId, event: changed }
}

const otherFacility = { data: { ...event.data, facilityId: 'DEPOT-OSTRAVA' } }
const otherShipment = { shipmentId: OTHER_SHIPMENT_ID, correlationId: OTHER_SHIPMENT_ID }

function resolveOne(copies: StoredCopy[]): ResolvedEvent {
  const resolved = resolveCopies(copies)
  expect([...resolved.keys()]).toEqual([event.eventId])
  return resolved.get(event.eventId)!
}

describe('resolveCopies', () => {
  it('is empty without copies', () => {
    expect(resolveCopies([])).toEqual(new Map())
  })

  it('keeps a single copy as it is', () => {
    const only = copy(5)

    expect(resolveOne([only])).toEqual({ kept: only, duplicates: [], conflicts: [] })
  })

  it('resolves every event on its own', () => {
    const other = parcel('parcel.delivered', '2026-10-28T14:00:00Z')
    const resolved = resolveCopies([
      copy(1),
      { streamSequence: 2, eventId: other.eventId, shipmentId: SHIPMENT_ID, event: other },
      copy(3),
    ])

    expect([...resolved].map(([id, r]) => [id, r.kept.streamSequence, r.duplicates])).toEqual([
      [event.eventId, 1, [3]],
      [other.eventId, 2, []],
    ])
  })

  it.each([
    ['a later instant that sorts first as a string', '2026-10-28T09:31:00.500Z', '2026-10-28T09:31:00Z'],
    ['the same instant: the code-unit smaller string', '2026-10-28T09:31:00Z', '2026-10-28T09:31:00.000Z'],
  ])('R1: takes the earliest receivedAt of equal copies, %s', (_name, first, second) => {
    const resolved = resolveOne([copy(1, { receivedAt: first }), copy(2, { receivedAt: second })])

    expect(resolved.kept).toEqual(copy(1, { receivedAt: second }))
    expect(resolved.duplicates).toEqual([2])
    expect(resolveOne([copy(1, { receivedAt: second }), copy(2, { receivedAt: first })]).kept).toEqual(
      copy(1, { receivedAt: second }),
    )
  })

  it('R1: takes the earliest of three equal copies, wherever it is in the stream', () => {
    const times = ['2026-10-28T09:31:00Z', '2026-10-28T09:30:10Z', '2026-10-28T09:30:20Z']

    for (const [a, b, c] of permutations(times)) {
      const resolved = resolveOne([copy(1, { receivedAt: a! }), copy(2, { receivedAt: b! }), copy(3, { receivedAt: c! })])
      expect(resolved.kept).toEqual(copy(1, { receivedAt: '2026-10-28T09:30:10Z' }))
      expect(resolved.duplicates).toEqual([2, 3])
    }
  })

  it('treats a time written differently as equal and keeps the text of the lowest sequence', () => {
    const resolved = resolveOne([copy(1), copy(2, { occurredAt: '2026-10-28T09:30:00.000Z' })])

    expect(resolved.conflicts).toEqual([])
    expect(resolved.kept).toEqual(copy(1))
  })

  it('keeps the lowest sequence of different copies, even if it was received later', () => {
    const resolved = resolveOne([copy(2, { ...otherFacility, receivedAt: '2026-10-28T09:30:01Z' }), copy(1)])

    expect(resolved).toEqual({
      kept: copy(1),
      duplicates: [],
      conflicts: [
        {
          eventId: event.eventId,
          streamSequence: 2,
          // Of the conflicting copy, not of the kept one.
          receivedAt: '2026-10-28T09:30:01Z',
          differingFields: ['data.facilityId'],
          shipmentIds: [SHIPMENT_ID],
        },
      ],
    })
  })

  it('names both shipments of a conflict between shipments, the one of the kept copy first', () => {
    const resolved = resolveOne([copy(1), copy(2, otherShipment)])

    expect(resolved.kept.shipmentId).toBe(SHIPMENT_ID)
    expect(resolved.conflicts).toMatchObject([
      { differingFields: ['correlationId', 'shipmentId'], shipmentIds: [SHIPMENT_ID, OTHER_SHIPMENT_ID] },
    ])
  })

  it('compares with the kept copy only: two equal conflicting copies are two conflicts', () => {
    const resolved = resolveOne([copy(1), copy(2, otherFacility), copy(3, otherFacility)])

    expect(resolved.conflicts.map((conflict) => conflict.streamSequence)).toEqual([2, 3])
  })

  it('does not take receivedAt from a conflicting copy', () => {
    const resolved = resolveOne([copy(1), copy(2, { ...otherFacility, receivedAt: '2026-10-28T09:30:01Z' })])

    expect(resolved.kept.event.receivedAt).toBe(event.receivedAt)
  })

  it('gives the same result for all orders of four copies and does not change its input', () => {
    const copies = [
      copy(1),
      copy(2, otherShipment),
      copy(3, { receivedAt: '2026-10-28T09:30:30Z' }),
      copy(4, otherFacility),
    ]
    const expected: ResolvedEvent = {
      kept: copy(1, { receivedAt: '2026-10-28T09:30:30Z' }),
      duplicates: [3],
      conflicts: [
        {
          eventId: event.eventId,
          streamSequence: 2,
          receivedAt: event.receivedAt,
          differingFields: ['correlationId', 'shipmentId'],
          shipmentIds: [SHIPMENT_ID, OTHER_SHIPMENT_ID],
        },
        {
          eventId: event.eventId,
          streamSequence: 4,
          receivedAt: event.receivedAt,
          differingFields: ['data.facilityId'],
          shipmentIds: [SHIPMENT_ID],
        },
      ],
    }
    const orders = permutations(copies)
    expect(orders).toHaveLength(24)

    for (const order of orders) {
      const before = structuredClone(order)
      expect(resolveOne(order)).toEqual(expected)
      expect(order).toEqual(before)
    }
  })
})

describe('messageOutcome', () => {
  it('is "new" for the first copy and "duplicate" for its redelivery', () => {
    const resolved = resolveOne([copy(1)])

    expect(messageOutcome(resolved, 1, true)).toBe('new')
    expect(messageOutcome(resolved, 1, false)).toBe('duplicate')
  })

  it('is "duplicate" for an equal copy, whichever arrives second', () => {
    const resolved = resolveOne([copy(1), copy(2)])

    expect(messageOutcome(resolved, 2, true)).toBe('duplicate')
    expect(messageOutcome(resolved, 1, true)).toBe('duplicate')
  })

  it('is "conflict" for a different copy, whichever arrives second, and for its redelivery', () => {
    const resolved = resolveOne([copy(1), copy(2, otherFacility)])

    expect(messageOutcome(resolved, 2, true)).toBe('conflict')
    expect(messageOutcome(resolved, 1, true)).toBe('conflict')
    expect(messageOutcome(resolved, 2, false)).toBe('conflict')
  })

  it('is "duplicate" for an equal copy or a redelivery of the kept one, although there is a conflict', () => {
    const resolved = resolveOne([copy(1), copy(2, otherFacility), copy(3)])

    expect(messageOutcome(resolved, 3, true)).toBe('duplicate')
    expect(messageOutcome(resolved, 1, false)).toBe('duplicate')
  })
})

it('hasCopy is true for every copy of the event and no other message', () => {
  const resolved = resolveOne([copy(1), copy(2, otherFacility), copy(3)])

  expect([1, 2, 3, 4].map((sequence) => hasCopy(resolved, sequence))).toEqual([true, true, true, false])
})
