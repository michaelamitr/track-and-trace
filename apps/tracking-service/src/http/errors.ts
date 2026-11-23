import { DatabaseUnavailableError } from '@tt/db'
import { errorBody, type MapServiceError } from '@tt/http'

/** Maps the Tracking Service's own errors; @tt/http handles the generic ones. */
export const mapServiceError: MapServiceError = (error, request) => {
  if (error instanceof DatabaseUnavailableError) {
    request.log.error({ err: error }, 'database unavailable')
    return {
      status: 503,
      body: errorBody('DEPENDENCY_UNAVAILABLE', 'The service is temporarily unavailable. Retry later.'),
    }
  }
  return undefined
}
