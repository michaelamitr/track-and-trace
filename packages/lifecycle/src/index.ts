// Technical process infrastructure only (ADR-0013, amendment 2026-11-26): running
// a service's stop steps with a deadline. Which steps, their order and the
// deadline value stay in each service.
export * from './shutdown.js'
