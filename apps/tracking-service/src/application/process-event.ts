import { withTransaction } from '@tt/db'
import type { MessageMetadata } from '@tt/messaging'
import type pg from 'pg'
import { deleteConflict, findConflicts, quarantineConflict, updateConflict } from '../db/quarantined-events.js'
import { deleteReadModel, replaceHistory, upsertShipmentTracking } from '../db/read-model.js'
import {
  findEventsByShipment,
  findKeptCopy,
  insertEventIfNew,
  replaceKeptCopy,
  type KeptCopy,
} from '../db/tracking-events.js'
import { differingFields } from '../domain/compare-copies.js'
import { mergeEqualCopies, type EventCopy } from '../domain/event-copy.js'
import { project } from '../domain/projection.js'
import { findRegistration } from '../domain/registration.js'
import type { TrackingEvent } from '../domain/shipment-status.js'

export type ProcessEventResult = 'processed' | 'duplicate' | 'conflict' | 'waiting_for_registration'

export type ProcessEvent = (event: TrackingEvent, metadata: MessageMetadata) => Promise<ProcessEventResult>

type StoreResult = {
  outcome: 'new' | 'duplicate' | 'conflict'
  /** Shipments to project again, in this order. */
  shipmentIds: string[]
}

/**
 * A conflicting copy that is earlier in the stream than the kept one, because
 * it was processed late (redelivered after a failure): it becomes the kept
 * copy and the quarantine is brought to the state of a replay in stream order.
 */
async function replaceWithEarlierInStream(client: pg.PoolClient, previous: KeptCopy, earlier: EventCopy) {
  let kept = earlier
  for (const copy of await findConflicts(client, earlier.event.eventId)) {
    const fields = differingFields(earlier.event, copy.event)
    if (fields.length === 0) {
      // It conflicted only with the previous kept copy; now it is a duplicate (R1).
      kept = mergeEqualCopies(kept, copy)
      await deleteConflict(client, copy)
    } else {
      await updateConflict(client, { copy, shipmentId: earlier.event.shipmentId, differingFields: fields })
    }
  }
  await replaceKeptCopy(client, kept)
  await quarantineConflict(client, {
    copy: previous,
    shipmentId: earlier.event.shipmentId,
    differingFields: differingFields(earlier.event, previous.event),
  })
}

/** Steps 1 and 2 of ADR-0011: stores a new event, or compares it with the kept copy. */
async function storeEvent(client: pg.PoolClient, copy: EventCopy): Promise<StoreResult> {
  const { event } = copy
  if (await insertEventIfNew(client, copy)) return { outcome: 'new', shipmentIds: [event.shipmentId] }

  const kept = await findKeptCopy(client, event.eventId)
  if (!kept) throw new Error(`Event ${event.eventId} conflicted on insert but was not found`)

  const fields = differingFields(kept.event, event)
  if (fields.length === 0) {
    await replaceKeptCopy(client, mergeEqualCopies(kept, copy))
    return { outcome: 'duplicate', shipmentIds: [kept.shipmentId] }
  }
  if (copy.streamSequence < kept.streamSequence) {
    await replaceWithEarlierInStream(client, kept, copy)
    // The event may have moved to another shipment: it leaves the previous one first.
    return { outcome: 'conflict', shipmentIds: [...new Set([kept.shipmentId, event.shipmentId])] }
  }
  await quarantineConflict(client, { copy, shipmentId: kept.shipmentId, differingFields: fields })
  return { outcome: 'conflict', shipmentIds: [kept.shipmentId] }
}

/**
 * Steps 3 and 4 of ADR-0011. Returns false while the shipment is not known. It
 * then has no read model; one is deleted only if its registration was replaced
 * by a copy that is earlier in the stream.
 */
async function updateReadModel(client: pg.PoolClient, shipmentId: string): Promise<boolean> {
  const events = await findEventsByShipment(client, shipmentId)
  const projection = project(events)
  const registration = findRegistration(events, projection)
  if (!registration) {
    await deleteReadModel(client, shipmentId)
    return false
  }
  await upsertShipmentTracking(client, shipmentId, registration.data.trackingNumber, projection)
  await replaceHistory(client, shipmentId, projection.history)
  return true
}

/**
 * Processes one message (ADR-0011). Everything happens in one transaction and
 * the promise resolves only after the commit, so the caller can ack. Safe to
 * call again with the same message: a redelivery changes nothing.
 */
export function createProcessEvent(deps: { pool: pg.Pool }): ProcessEvent {
  return function processEvent(event, { subject, streamSequence }) {
    return withTransaction(deps.pool, async (client) => {
      const { outcome, shipmentIds } = await storeEvent(client, { event, subject, streamSequence })
      let isKnown = false
      for (const shipmentId of shipmentIds) isKnown = await updateReadModel(client, shipmentId)
      if (outcome !== 'new') return outcome
      return isKnown ? 'processed' : 'waiting_for_registration'
    })
  }
}
