import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { NATS_IMAGE } from './test-nats.js'

const composeUrl = new URL('../../../compose.yaml', import.meta.url)

describe('NATS_IMAGE', () => {
  it('matches the nats service image in compose.yaml', async () => {
    const compose = parse(await readFile(composeUrl, 'utf8')) as {
      services?: { nats?: { image?: unknown } }
    }
    expect(compose.services?.nats?.image).toBe(NATS_IMAGE)
  })
})
