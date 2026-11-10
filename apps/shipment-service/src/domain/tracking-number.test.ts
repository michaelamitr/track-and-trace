import { afterEach, describe, expect, it, vi } from 'vitest'

const randomInt = vi.hoisted(() => vi.fn())
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomInt: (...args: Parameters<typeof actual.randomInt>) => randomInt(...args) }
})

const { generateTrackingNumber } = await import('./tracking-number.js')

afterEach(() => {
  randomInt.mockReset()
})

describe('generateTrackingNumber', () => {
  it('is "PF-" followed by exactly ten digits', async () => {
    const { randomInt: realRandomInt } = await vi.importActual<typeof import('node:crypto')>('node:crypto')
    randomInt.mockImplementation(realRandomInt)

    for (let i = 0; i < 1000; i++) {
      expect(generateTrackingNumber()).toMatch(/^PF-\d{10}$/)
    }
  })

  it('draws from the whole ten-digit range with crypto.randomInt', () => {
    randomInt.mockReturnValue(0)
    generateTrackingNumber()

    expect(randomInt).toHaveBeenCalledWith(0, 10_000_000_000)
  })

  it('keeps leading zeros', () => {
    randomInt.mockReturnValue(42)
    expect(generateTrackingNumber()).toBe('PF-0000000042')
  })

  it('uses all ten digits for the largest value', () => {
    randomInt.mockReturnValue(9_999_999_999)
    expect(generateTrackingNumber()).toBe('PF-9999999999')
  })
})
