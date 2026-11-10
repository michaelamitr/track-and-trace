import { describe, expect, it } from 'vitest'
import { RegisterShipmentBodySchema, ShipmentParamsSchema } from './schemas.js'

const valid = {
  orderReference: 'ESHOP-2026-004211',
  originFacilityId: 'PRG-HUB-01',
  destination: 'Brno',
  recipientId: 'cust-88231',
  expectedDeliveryAt: '2026-11-11T16:00:00Z',
}

function failedPaths(input: unknown) {
  const result = RegisterShipmentBodySchema.safeParse(input)
  expect(result.success).toBe(false)
  return result.error?.issues.map((issue) => issue.path)
}

describe('RegisterShipmentBodySchema', () => {
  it('accepts the example from docs/shipment-api.md', () => {
    expect(RegisterShipmentBodySchema.parse(valid)).toEqual(valid)
  })

  it('accepts an orderReference of 64 characters and fractional seconds', () => {
    const body = { ...valid, orderReference: 'x'.repeat(64), expectedDeliveryAt: '2026-11-11T16:00:00.5Z' }
    expect(RegisterShipmentBodySchema.safeParse(body).success).toBe(true)
  })

  it('rejects a time with an offset instead of Z', () => {
    expect(failedPaths({ ...valid, expectedDeliveryAt: '2026-11-11T17:00:00+01:00' })).toEqual([
      ['expectedDeliveryAt'],
    ])
  })

  it('rejects a time without a time zone', () => {
    expect(failedPaths({ ...valid, expectedDeliveryAt: '2026-11-11T16:00:00' })).toEqual([['expectedDeliveryAt']])
  })

  it('rejects an empty orderReference', () => {
    expect(failedPaths({ ...valid, orderReference: '' })).toEqual([['orderReference']])
  })

  it('rejects an orderReference of 65 characters', () => {
    expect(failedPaths({ ...valid, orderReference: 'x'.repeat(65) })).toEqual([['orderReference']])
  })

  it.each(['originFacilityId', 'destination', 'recipientId'] as const)('rejects an empty %s', (field) => {
    expect(failedPaths({ ...valid, [field]: '' })).toEqual([[field]])
  })

  it.each(Object.keys(valid))('rejects a missing %s', (field) => {
    const body: Record<string, unknown> = { ...valid }
    delete body[field]
    expect(failedPaths(body)).toEqual([[field]])
  })
})

describe('ShipmentParamsSchema', () => {
  it('accepts a UUID and rejects anything else', () => {
    expect(ShipmentParamsSchema.safeParse({ shipmentId: '0d40c8bb-e48f-4311-9223-1a54a7e197e4' }).success).toBe(
      true,
    )
    expect(ShipmentParamsSchema.safeParse({ shipmentId: 'not-a-uuid' }).success).toBe(false)
  })
})
