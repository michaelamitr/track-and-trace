import { fileURLToPath } from 'node:url'

/** Absolute path, so the result does not depend on the current directory. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))
