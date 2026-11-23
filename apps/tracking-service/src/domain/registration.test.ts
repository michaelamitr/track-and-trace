import { describe, expect, it } from 'vitest'
import { parcel, registered } from '../test-events.js'
import { project } from './projection.js'
import { findRegistration } from './registration.js'
import type { TrackingEvent } from './shipment-status.js'

const find = (events: TrackingEvent[]) => findRegistration(events, project(events))

describe('findRegistration', () => {
  it('is null without shipment.registered', () => {
    expect(find([])).toBeNull()
    expect(find([parcel('parcel.accepted', '2026-10-28T08:15:00Z')])).toBeNull()
  })

  it('finds the registration among scans, even if a scan occurred before it', () => {
    const registration = registered('2026-10-28T08:00:00Z')
    const events = [parcel('parcel.accepted', '2026-10-28T07:00:00Z'), registration]

    expect(find(events)).toBe(registration)
  })

  it('uses the first one in R2 order if a shipment was registered twice, in both input orders', () => {
    const first = registered('2026-10-28T08:00:00Z')
    const second = registered('2026-10-28T08:00:00.500Z')

    expect(find([first, second])).toBe(first)
    expect(find([second, first])).toBe(first)
  })
})
