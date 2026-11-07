import { describe, expect, it } from 'vitest'
import { SUBJECTS } from '@tt/contracts'
import { CONSUMERS } from './consumers.js'
import { LOGISTICS_STREAM } from './stream.js'

describe('CONSUMERS', () => {
  it('use the filter subjects from ARCHITECTURE.md', () => {
    expect(CONSUMERS.tracking.filter_subjects).toEqual([
      'logistics.shipment.registered.v1',
      'logistics.parcel.>',
    ])
    expect(CONSUMERS['sla-monitoring'].filter_subjects).toEqual([
      'logistics.shipment.registered.v1',
      'logistics.parcel.delivered.v1',
    ])
    expect(CONSUMERS.notification.filter_subjects).toEqual([
      'logistics.shipment.registered.v1',
      'logistics.parcel.delivered.v1',
      'logistics.sla.breached.v1',
    ])
  })

  it('are durable under their own name', () => {
    for (const [name, config] of Object.entries(CONSUMERS)) {
      expect(config.durable_name).toBe(name)
    }
  })

  it('only filter on subjects of the stream', () => {
    const known = new Set<string>(Object.values(SUBJECTS))
    for (const config of Object.values(CONSUMERS)) {
      for (const subject of [config.filter_subjects ?? []].flat()) {
        expect(subject === 'logistics.parcel.>' || known.has(subject)).toBe(true)
      }
    }
    expect(LOGISTICS_STREAM.subjects).toEqual(['logistics.>'])
  })
})
