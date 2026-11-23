import { z } from 'zod'

/** Error codes every service uses; a service can add its own (errorBodySchema). */
export const SHARED_ERROR_CODES = [
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'NOT_FOUND',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const

export type SharedErrorCode = (typeof SHARED_ERROR_CODES)[number]

export type ErrorBody<OwnCode extends string = never> = {
  error: {
    code: SharedErrorCode | OwnCode
    message: string
    /** Only for validation errors: the failing fields. */
    details?: { path: string; message: string }[] | undefined
  }
}

/** Response schema of the error body with the shared codes and the service's own ones. */
export function errorBodySchema<const OwnCode extends string = never>(ownCodes: readonly OwnCode[] = []) {
  return z.object({
    error: z.object({
      code: z.enum([...SHARED_ERROR_CODES, ...ownCodes]),
      message: z.string(),
      details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    }),
  })
}

/** Only shared codes are accepted unless the service names its own: errorBody<'ORDER_CONFLICT'>(...). */
export function errorBody<OwnCode extends string = never>(
  code: SharedErrorCode | NoInfer<OwnCode>,
  message: string,
  details?: { path: string; message: string }[],
): ErrorBody<OwnCode> {
  return { error: { code, message, ...(details ? { details } : {}) } }
}
