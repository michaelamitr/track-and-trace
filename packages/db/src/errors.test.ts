import { describe, expect, it } from 'vitest'
import {
  DatabaseUnavailableError,
  isDatabaseUnavailable,
  isQueryReadTimeout,
  translateDatabaseError,
} from './errors.js'

function withCode(message: string, code: string) {
  return Object.assign(new Error(message), { code })
}

describe('isDatabaseUnavailable', () => {
  it.each([
    ['connection refused', withCode('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED')],
    ['pool connect timeout', new Error('timeout exceeded when trying to connect')],
    ['connection lost', new Error('Connection terminated unexpectedly')],
    ['admin shutdown', withCode('terminating connection due to administrator command', '57P01')],
    ['connection exception class 08', withCode('connection failure', '08006')],
    ['statement timeout', withCode('canceling statement due to statement timeout', '57014')],
    ['query read timeout of the client', new Error('Query read timeout')],
    ['IPv4 and IPv6 refused', new AggregateError([withCode('a', 'ECONNREFUSED'), withCode('b', 'ECONNREFUSED')])],
  ])('is true for %s', (_name, err) => {
    expect(isDatabaseUnavailable(err)).toBe(true)
  })

  it.each([
    ['unique violation', withCode('duplicate key', '23505')],
    ['undefined table', withCode('relation does not exist', '42P01')],
    ['plain error', new Error('boom')],
    ['not an error', 'ECONNREFUSED'],
  ])('is false for %s', (_name, err) => {
    expect(isDatabaseUnavailable(err)).toBe(false)
  })
})

describe('isQueryReadTimeout', () => {
  it('is true for the error of pg and for an error caused by it', () => {
    const timeout = new Error('Query read timeout')
    expect(isQueryReadTimeout(timeout)).toBe(true)
    expect(isQueryReadTimeout(new Error('wrapped', { cause: timeout }))).toBe(true)
  })

  it('is false for a statement timeout and other errors', () => {
    expect(isQueryReadTimeout(withCode('canceling statement due to statement timeout', '57014'))).toBe(false)
    expect(isQueryReadTimeout(new Error('boom'))).toBe(false)
    expect(isQueryReadTimeout('Query read timeout')).toBe(false)
  })
})

describe('translateDatabaseError', () => {
  it('wraps an unavailability error and keeps the cause', () => {
    const cause = withCode('refused', 'ECONNREFUSED')
    const translated = translateDatabaseError(cause)
    expect(translated).toBeInstanceOf(DatabaseUnavailableError)
    expect((translated as Error).cause).toBe(cause)
  })

  it('returns other errors unchanged', () => {
    const err = withCode('duplicate key', '23505')
    expect(translateDatabaseError(err)).toBe(err)
  })
})
