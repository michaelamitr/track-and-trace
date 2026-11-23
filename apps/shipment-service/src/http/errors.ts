import { DatabaseUnavailableError } from '@tt/db'
import { errorBody, type MapServiceError } from '@tt/http'
import { OrderConflictError } from '../application/register-shipment.js'
import type { OwnErrorCode } from './schemas.js'

/** Maps the Shipment Service's own errors; @tt/http handles the generic ones. */
export const mapServiceError: MapServiceError<OwnErrorCode> = (error, request) => {
  if (error instanceof OrderConflictError) {
    return {
      status: 409,
      body: errorBody('ORDER_CONFLICT', 'The orderReference is already registered with different data.'),
    }
  }
  if (error instanceof DatabaseUnavailableError) {
    request.log.error({ err: error }, 'database unavailable')
    return {
      status: 503,
      body: errorBody('DEPENDENCY_UNAVAILABLE', 'The service is temporarily unavailable. Retry later.'),
    }
  }
  return undefined
}
