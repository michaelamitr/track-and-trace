// Technical HTTP infrastructure only (ADR-0013): no business logic, no domain
// types. Routes, schemas and the mapping of own errors stay in each service.
export * from './app.js'
export * from './error-body.js'
export * from './error-handler.js'
export * from './health.js'
