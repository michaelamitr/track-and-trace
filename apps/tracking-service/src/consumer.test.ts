import { DatabaseUnavailableError } from '@tt/db'
import { describe, expect, it } from 'vitest'
import { isTransient } from './consumer.js'
import { QuarantineConflictError } from './db/quarantine.js'

describe('isTransient (ADR-0015 rule 1)', () => {
  it('is true for an unavailable database, which includes both time limits', () => {
    expect(isTransient(new DatabaseUnavailableError({ cause: new Error('Query read timeout') }))).toBe(true)
  })

  it.each([
    ['an event Tracking does not consume', new Error('Unexpected sla.breached on logistics.parcel.delivered.v1')],
    ['a stream sequence stored with another event', new Error('Stream sequence 3 is already stored with another event.')],
    ['a quarantine conflict', new QuarantineConflictError('already quarantined')],
    ['a database error that waiting does not fix', Object.assign(new Error('permission denied'), { code: '42501' })],
    ['an untranslated timeout', Object.assign(new Error('canceling statement'), { code: '57014' })],
  ])('is false for %s', (_name, err) => {
    expect(isTransient(err)).toBe(false)
  })
})
