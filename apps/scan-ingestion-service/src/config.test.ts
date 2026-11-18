import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.js'

describe('loadConfig', () => {
  it('uses the defaults', () => {
    expect(loadConfig({})).toEqual({ natsUrl: 'nats://localhost:4222', port: 3002, host: '127.0.0.1' })
  })

  it('reads every variable', () => {
    expect(
      loadConfig({ NATS_URL: 'nats://nats:4222', SCAN_INGESTION_PORT: '8080', HOST: '0.0.0.0' }),
    ).toEqual({ natsUrl: 'nats://nats:4222', port: 8080, host: '0.0.0.0' })
  })

  it("ignores PORT and the Shipment Service's SHIPMENT_PORT", () => {
    expect(loadConfig({ PORT: '8080', SHIPMENT_PORT: '3001' }).port).toBe(3002)
  })

  it('lists every invalid value', () => {
    let error: unknown
    try {
      loadConfig({ NATS_URL: 'http://x', SCAN_INGESTION_PORT: '70000' })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ConfigError)
    const message = (error as Error).message
    expect(message).toMatch(/NATS_URL must be/)
    expect(message).toMatch(/SCAN_INGESTION_PORT must be an integer/)
  })

  it.each(['0', '3002.5', 'abc', '-1'])('rejects SCAN_INGESTION_PORT=%s', (port) => {
    expect(() => loadConfig({ SCAN_INGESTION_PORT: port })).toThrow(/SCAN_INGESTION_PORT must be/)
  })
})
