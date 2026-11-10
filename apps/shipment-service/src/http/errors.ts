import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { OrderConflictError } from '../application/register-shipment.js'
import { DatabaseUnavailableError } from '../db/errors.js'
import type { ErrorBody, ErrorCode } from './schemas.js'

export class NotFoundError extends Error {
  override name = 'NotFoundError'
}

export function errorBody(code: ErrorCode, message: string, details?: ErrorBody['error']['details']): ErrorBody {
  return { error: { code, message, ...(details ? { details } : {}) } }
}

/** "/expectedDeliveryAt" -> "expectedDeliveryAt", "" -> "" */
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
  if (error instanceof NotFoundError) {
    return reply.status(404).send(errorBody('NOT_FOUND', error.message))
  }
  if (error instanceof OrderConflictError) {
    return reply
      .status(409)
      .send(errorBody('ORDER_CONFLICT', 'The orderReference is already registered with different data.'))
  }
  if (error instanceof DatabaseUnavailableError) {
    request.log.error({ err: error }, 'database unavailable')
    return reply
      .status(503)
      .send(errorBody('DEPENDENCY_UNAVAILABLE', 'The service is temporarily unavailable. Retry later.'))
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
