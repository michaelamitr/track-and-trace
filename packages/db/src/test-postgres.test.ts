import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { passwordVariable, POSTGRES_IMAGE, TEST_PASSWORDS } from './test-postgres.js'

const composeUrl = new URL('../../../compose.yaml', import.meta.url)
const initDirUrl = new URL('../../../infra/postgres/init/', import.meta.url)

describe('POSTGRES_IMAGE', () => {
  it('matches the postgres service image in compose.yaml', async () => {
    const compose = parse(await readFile(composeUrl, 'utf8')) as {
      services?: { postgres?: { image?: unknown } }
    }
    expect(compose.services?.postgres?.image).toBe(POSTGRES_IMAGE)
  })
})

describe('TEST_PASSWORDS', () => {
  it('has a password for every variable the init scripts require', async () => {
    const files = (await readdir(initDirUrl)).sort()
    const scripts = await Promise.all(files.map((file) => readFile(new URL(file, initDirUrl), 'utf8')))
    const required = scripts.flatMap((script) =>
      [...script.matchAll(/\$\{([A-Z_]+_PASSWORD):\?/g)].map((match) => match[1]!),
    )

    expect(required).toEqual(expect.arrayContaining(['SHIPMENT_OWNER_PASSWORD', 'TRACKING_OWNER_PASSWORD']))
    expect(Object.keys(TEST_PASSWORDS).map(passwordVariable)).toEqual(expect.arrayContaining(required))
  })
})
