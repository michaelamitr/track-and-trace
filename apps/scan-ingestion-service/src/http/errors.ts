import { errorBody, type MapServiceError } from '@tt/http'
import { ZodError } from 'zod'
import { OccurredAtInFutureError, PublishFailedError } from '../application/ingest-scan.js'

/** Maps the Scan Ingestion Service's own errors; @tt/http handles the generic ones. */
export const mapServiceError: MapServiceError = (error, request) => {
  if (error instanceof OccurredAtInFutureError) {
    return {
      status: 400,
      body: errorBody('VALIDATION_ERROR', 'The request is invalid.', [
        { path: 'body.occurredAt', message: error.message },
      ]),
    }
  }
  if (error instanceof PublishFailedError) {
    request.log.warn(
      {
        err: error.cause,
        eventId: error.event.eventId,
        shipmentId: error.event.shipmentId,
        correlationId: error.event.correlationId,
      },
      'publish failed',
    )
    return {
      status: 503,
      body: errorBody('DEPENDENCY_UNAVAILABLE', 'The service is temporarily unavailable. Retry later.'),
    }
  }
  if (error instanceof ZodError) {
    // The service built an event that fails its own contract: a bug, not a client error.
    request.log.error({ err: error }, 'built event is invalid')
    return { status: 500, body: errorBody('INTERNAL_ERROR', 'Internal server error.') }
  }
  return undefined
}
