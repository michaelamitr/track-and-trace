import { randomInt } from 'node:crypto'

const DIGITS = 10
const UPPER_BOUND = 10 ** DIGITS // exclusive

/** "PF-" + 10 random digits (leading zeros kept). Uniqueness is enforced by the database. */
export function generateTrackingNumber(): string {
  return `PF-${String(randomInt(0, UPPER_BOUND)).padStart(DIGITS, '0')}`
}
