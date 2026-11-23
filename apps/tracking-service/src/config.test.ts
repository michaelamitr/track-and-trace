import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.js'

const databaseUrl = 'postgres://tracking_service:secret123@localhost:5432/tracking_db'

describe('loadConfig', () => {
  it('uses the defaults for everything but the database URL', () => {
    expect(loadConfig({ TRACKING_DATABASE_URL: databaseUrl })).toEqual({
      databaseUrl,
      natsUrl: 'nats://localhost:4222',
      port: 3003,
      host: '127.0.0.1',
    })
  })

  it('reads every variable', () => {
    expect(
      loadConfig({ TRACKING_DATABASE_URL: databaseUrl, NATS_URL: 'nats://nats:4222', TRACKING_PORT: '8080', HOST: '0.0.0.0' }),
    ).toEqual({ databaseUrl, natsUrl: 'nats://nats:4222', port: 8080, host: '0.0.0.0' })
  })

  it('fails when TRACKING_DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/TRACKING_DATABASE_URL is not set/)
  })

  it('lists every invalid value and never includes the database URL', () => {
    const env = { TRACKING_DATABASE_URL: 'mysql://user:secret123@host/db', NATS_URL: 'http://x', TRACKING_PORT: '70000' }
    let error: unknown
    try {
      loadConfig(env)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ConfigError)
    const message = (error as Error).message
    expect(message).toMatch(/TRACKING_DATABASE_URL must be a postgres/)
    expect(message).toMatch(/NATS_URL must be/)
    expect(message).toMatch(/TRACKING_PORT must be an integer/)
    expect(message).not.toContain('secret123')
  })

  it.each(['0', '3003.5', 'abc', '-1'])('rejects TRACKING_PORT=%s', (port) => {
    expect(() => loadConfig({ TRACKING_DATABASE_URL: databaseUrl, TRACKING_PORT: port })).toThrow(
      /TRACKING_PORT must be/,
    )
  })

  it('ignores the generic PORT variable', () => {
    expect(loadConfig({ TRACKING_DATABASE_URL: databaseUrl, PORT: '8080' }).port).toBe(3003)
  })
})
