import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.js'

const databaseUrl = 'postgres://shipment_service:secret123@localhost:5432/shipment_db'

describe('loadConfig', () => {
  it('uses the defaults for everything but the database URL', () => {
    expect(loadConfig({ SHIPMENT_DATABASE_URL: databaseUrl })).toEqual({
      databaseUrl,
      natsUrl: 'nats://localhost:4222',
      port: 3001,
      host: '127.0.0.1',
    })
  })

  it('reads every variable', () => {
    expect(
      loadConfig({ SHIPMENT_DATABASE_URL: databaseUrl, NATS_URL: 'nats://nats:4222', PORT: '8080', HOST: '0.0.0.0' }),
    ).toEqual({ databaseUrl, natsUrl: 'nats://nats:4222', port: 8080, host: '0.0.0.0' })
  })

  it('fails when SHIPMENT_DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/SHIPMENT_DATABASE_URL is not set/)
  })

  it('lists every invalid value and never includes the database URL', () => {
    const env = { SHIPMENT_DATABASE_URL: 'mysql://user:secret123@host/db', NATS_URL: 'http://x', PORT: '70000' }
    let error: unknown
    try {
      loadConfig(env)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ConfigError)
    const message = (error as Error).message
    expect(message).toMatch(/SHIPMENT_DATABASE_URL must be a postgres/)
    expect(message).toMatch(/NATS_URL must be/)
    expect(message).toMatch(/PORT must be an integer/)
    expect(message).not.toContain('secret123')
  })

  it.each(['0', '3001.5', 'abc', '-1'])('rejects PORT=%s', (port) => {
    expect(() => loadConfig({ SHIPMENT_DATABASE_URL: databaseUrl, PORT: port })).toThrow(/PORT must be/)
  })
})
