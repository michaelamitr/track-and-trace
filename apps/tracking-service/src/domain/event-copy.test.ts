import { describe, expect, it } from 'vitest'
import { parcel } from '../test-events.js'
import { mergeEqualCopies, type EventCopy } from './event-copy.js'

const event = parcel('parcel.arrived_at_hub', '2026-10-28T09:30:00Z')
const copy = (streamSequence: number, receivedAt: string): EventCopy => ({
  event: { ...event, receivedAt },
  subject: `subject-${streamSequence}`,
  streamSequence,
})

describe('mergeEqualCopies', () => {
  it.each([
    ['the first in the stream was also received earlier', copy(1, '2026-10-28T09:31:00Z'), copy(2, '2026-10-28T09:31:00.500Z'), 1],
    ['the second in the stream was received earlier', copy(1, '2026-10-28T09:31:00.500Z'), copy(2, '2026-10-28T09:31:00Z'), 2],
  ])('keeps the earlier received copy and the lower stream sequence: %s', (_name, first, second, earlier) => {
    const expected = {
      event: earlier === 1 ? first.event : second.event,
      subject: 'subject-1',
      streamSequence: 1,
    }

    expect(mergeEqualCopies(first, second)).toEqual(expected)
    expect(mergeEqualCopies(second, first)).toEqual(expected)
  })
})
