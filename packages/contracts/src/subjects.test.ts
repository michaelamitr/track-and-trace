import { describe, expect, it } from 'vitest'
import { SUBJECTS } from './subjects.js'

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