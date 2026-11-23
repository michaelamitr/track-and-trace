import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import Fastify, { type FastifyBaseLogger, type FastifyServerOptions } from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import { errorBody } from './error-body.js'
import { createErrorHandler, type MapServiceError } from './error-handler.js'

/** A ready logger (main.ts) or Fastify logger options; tests pass false. */
export type LoggerOption = FastifyBaseLogger | FastifyServerOptions['logger']

export type HttpAppOptions = {
  /** Title and description of the OpenAPI document. */
  title: string
  description: string
  /** The service's own errors; without it only the generic cases apply. */
  mapServiceError?: MapServiceError<string>
  /** Default: Fastify's own logger. */
  logger?: LoggerOption
}

/** A Fastify app whose routes are typed by their Zod schemas. */
export type HttpApp = Awaited<ReturnType<typeof createHttpApp>>

function isLoggerInstance(logger: LoggerOption): logger is FastifyBaseLogger {
  return typeof logger === 'object' && logger !== null && typeof (logger as FastifyBaseLogger).child === 'function'
}

/**
 * Creates the Fastify app of a service without listening: Zod schemas, the
 * error handler, the 404 for unknown routes, the OpenAPI document and Swagger
 * UI at /docs. The service adds its routes and health routes.
 */
export async function createHttpApp(options: HttpAppOptions) {
  const logger = options.logger ?? true
  const app = Fastify(isLoggerInstance(logger) ? { loggerInstance: logger } : { logger })
    .withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.setErrorHandler(createErrorHandler(options.mapServiceError))
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(errorBody('NOT_FOUND', `Route ${request.method} ${request.url} not found.`)),
  )

  await app.register(swagger, {
    openapi: {
      info: { title: options.title, description: options.description, version: '1.0.0' },
    },
    transform: jsonSchemaTransform,
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  return app
}
