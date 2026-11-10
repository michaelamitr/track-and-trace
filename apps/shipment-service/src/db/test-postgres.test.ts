import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { POSTGRES_IMAGE } from './test-postgres.js'

const composeUrl = new URL('../../../../compose.yaml', import.meta.url)

describe('POSTGRES_IMAGE', () => {
  it('matches the postgres service image in compose.yaml', async () => {
    const compose = parse(await readFile(composeUrl, 'utf8')) as {
      services?: { postgres?: { image?: unknown } }
    }
    expect(compose.services?.postgres?.image).toBe(POSTGRES_IMAGE)
  })
})
