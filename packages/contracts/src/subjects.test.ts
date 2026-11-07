import { describe, expect, it } from 'vitest'
import { EVENT_TYPES } from './envelope.js'
import { SUBJECTS, subjectForEvent } from './subjects.js'

const all = Object.values(SUBJECTS)

describe('SUBJECTS', () => {
  it('belong to the logistics.>', () => {
    for (const subject of all) {
      expect(subject.startsWith('logistics.')).toBe(true)
    }
  })

  it('are versioned', () => {
    for (const subject of all) {
      expect(subject).toMatch(/\.v\d+$/)
    }
  })

  it('are unique', () => {
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('subjectForEvent', () => {
  it('maps every event type to a value of SUBJECTS', () => {
    for (const eventType of EVENT_TYPES) {
      expect(all).toContain(subjectForEvent({ eventType, eventVersion: 1 }))
    }
  })

  it('builds logistics.<eventType>.v<eventVersion>', () => {
    expect(subjectForEvent({ eventType: 'parcel.delivered', eventVersion: 1 })).toBe(
      'logistics.parcel.delivered.v1',
    )
  })
})
