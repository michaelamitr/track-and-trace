import { withTransaction } from '@tt/db'
import type { MessageMetadata } from '@tt/messaging'
import type pg from 'pg'
import {
  deleteHistoryAndConflicts,
  deleteShipmentTracking,
  insertConflicts,
  insertHistory,
  upsertShipmentTracking,
} from '../db/read-model.js'
import { findCopies, findShipmentsOfEvent, insertMessageIfNew } from '../db/received-messages.js'
import { project } from '../domain/projection.js'
import { findRegistration } from '../domain/registration.js'
import { hasCopy, messageOutcome, resolveCopies, type ResolvedEvent } from '../domain/resolve-copies.js'
import type { TrackingEvent } from '../domain/shipment-status.js'

export type ProcessEventResult = 'processed' | 'duplicate' | 'conflict' | 'waiting_for_registration'

export type ProcessEvent = (event: TrackingEvent, metadata: MessageMetadata) => Promise<ProcessEventResult>

/** Writes the read model of one shipment. Returns false if it is not known and has none. */
async function writeReadModel(
  client: pg.PoolClient,
  shipmentId: string,
  resolved: ResolvedEvent[],
): Promise<boolean> {
  const events = resolved.filter(({ kept }) => kept.shipmentId === shipmentId).map(({ kept }) => kept.event)
  const projection = project(events)
  const registration = findRegistration(events, projection)
  if (!registration) {
    await deleteShipmentTracking(client, shipmentId)
    return false
  }
  const conflicts = resolved
    .flatMap((event) => event.conflicts)
    .filter((conflict) => conflict.shipmentIds.includes(shipmentId))
  await upsertShipmentTracking(client, shipmentId, registration.data.trackingNumber, projection)
  await insertHistory(client, shipmentId, projection.history)
  await insertConflicts(client, shipmentId, conflicts)
  return true
}

/**
 * Processes one message (ADR-0014). Everything happens in one transaction and
 * the promise resolves only after the commit, so the caller can ack. The read
 * model follows from the stored messages only, so neither the processing order
 * nor a redelivery changes it.
 */
export function createProcessEvent(deps: { pool: pg.Pool }): ProcessEvent {
  return function processEvent(event, metadata) {
    return withTransaction(deps.pool, async (client) => {
      const isNewMessage = await insertMessageIfNew(client, event, metadata)

      const shipmentIds = await findShipmentsOfEvent(client, event.eventId)
      const resolved = resolveCopies(await findCopies(client, shipmentIds))
      // Postgres returns a uuid in lowercase.
      const resolvedEvent = resolved.get(event.eventId.toLowerCase())
      if (!resolvedEvent || !hasCopy(resolvedEvent, metadata.streamSequence)) {
        throw new Error(
          `Stream sequence ${metadata.streamSequence} is already stored with another event. ` +
            'The stream and tracking_db must be reset together (ADR-0014).',
        )
      }

      // First for all shipments: an event can leave one history and enter another.
      await deleteHistoryAndConflicts(client, shipmentIds)
      const known = new Set<string>()
      for (const shipmentId of shipmentIds) {
        if (await writeReadModel(client, shipmentId, [...resolved.values()])) known.add(shipmentId)
      }

      const outcome = messageOutcome(resolvedEvent, metadata.streamSequence, isNewMessage)
      if (outcome !== 'new') return outcome
      return known.has(resolvedEvent.kept.shipmentId) ? 'processed' : 'waiting_for_registration'
    })
  }
}
