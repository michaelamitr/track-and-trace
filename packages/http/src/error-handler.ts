import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'
import { errorBody, type ErrorBody, type SharedErrorCode } from './error-body.js'

/** The requested resource does not exist (404); the message is returned to the client. */
export class NotFoundError extends Error {
  override name = 'NotFoundError'
}

export type ErrorResponse<OwnCode extends string = never> = { status: number; body: ErrorBody<OwnCode> }

/**
 * Maps one of the service's own errors to a response, and logs it if needed.
 * Returns undefined for every other error; the generic cases then apply.
 */
export type MapServiceError<OwnCode extends string = never> = (
  error: unknown,
  request: FastifyRequest,
) => ErrorResponse<OwnCode> | undefined

/** "/expectedDeliveryAt" -> "expectedDeliveryAt", "" -> "" */
function fieldPath(instancePath: string): string {
  return instancePath.replace(/^\//, '').replaceAll('/', '.')
}

/**
 * Creates the error handler that maps every error to the error body; internal
 * details are logged, never returned. The service's own errors come from `mapServiceError`.
 */
export function createErrorHandler(mapServiceError?: MapServiceError<string>) {
  return function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
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
    const mapped = mapServiceError?.(error, request)
    if (mapped) return reply.status(mapped.status).send(mapped.body)
    // Client errors raised by Fastify itself (malformed JSON, wrong content type, body too large).
    const status = error.statusCode
    if (status !== undefined && status >= 400 && status < 500) {
      const code: SharedErrorCode = status === 400 ? 'VALIDATION_ERROR' : 'BAD_REQUEST'
      return reply.status(status).send(errorBody(code, error.message))
    }
    request.log.error({ err: error }, 'unhandled error')
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Internal server error.'))
  }
}
