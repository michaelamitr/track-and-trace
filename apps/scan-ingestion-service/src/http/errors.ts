// Copied from the Shipment Service and adapted; a shared HTTP package is planned (lesson 2.4).
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { ZodError } from 'zod'
import { OccurredAtInFutureError, PublishFailedError } from '../application/ingest-scan.js'
import type { ErrorBody, ErrorCode } from './schemas.js'

export function errorBody(code: ErrorCode, message: string, details?: ErrorBody['error']['details']): ErrorBody {
  return { error: { code, message, ...(details ? { details } : {}) } }
}

/** "/occurredAt" -> "occurredAt", "" -> "" */
function fieldPath(instancePath: string): string {
  return instancePath.replace(/^\//, '').replaceAll('/', '.')
}

/** Maps every error to the error body; internal details are logged, never returned. */
export function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (hasZodFastifySchemaValidationErrors(error)) {
    const details = error.validation.map((issue) => ({
      path: [error.validationContext, fieldPath(issue.instancePath)].filter(Boolean).join('.'),
      message: issue.message ?? 'invalid value',
    }))
    return reply.status(400).send(errorBody('VALIDATION_ERROR', 'The request is invalid.', details))
  }
  if (error instanceof OccurredAtInFutureError) {
    return reply
      .status(400)
      .send(errorBody('VALIDATION_ERROR', 'The request is invalid.', [{ path: 'body.occurredAt', message: error.message }]))
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
    return reply
      .status(503)
      .send(errorBody('DEPENDENCY_UNAVAILABLE', 'The service is temporarily unavailable. Retry later.'))
  }
  if (error instanceof ZodError) {
    // The service built an event that fails its own contract: a bug, not a client error.
    request.log.error({ err: error }, 'built event is invalid')
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Internal server error.'))
  }
  // Client errors raised by Fastify itself (malformed JSON, wrong content type, body too large).
  const status = error.statusCode
  if (status !== undefined && status >= 400 && status < 500) {
    const code: ErrorCode = status === 400 ? 'VALIDATION_ERROR' : 'BAD_REQUEST'
    return reply.status(status).send(errorBody(code, error.message))
  }
  request.log.error({ err: error }, 'unhandled error')
  return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Internal server error.'))
}
