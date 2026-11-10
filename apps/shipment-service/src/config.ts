export type Config = {
  /** shipment_service runtime role (data only). Never log it: it contains a password. */
  databaseUrl: string
  natsUrl: string
  port: number
  host: string
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

type Env = Record<string, string | undefined>

/**
 * Reads the configuration from the environment and throws a ConfigError that
 * lists every missing or invalid variable. Error messages never contain the
 * values, because the database URL contains a password.
 */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = []

  const databaseUrl = env.SHIPMENT_DATABASE_URL?.trim()
  if (!databaseUrl) {
    problems.push('SHIPMENT_DATABASE_URL is not set (see .env.example).')
  } else if (!hasProtocol(databaseUrl, ['postgres:', 'postgresql:'])) {
    problems.push('SHIPMENT_DATABASE_URL must be a postgres:// or postgresql:// URL.')
  }

  const natsUrl = env.NATS_URL?.trim() || 'nats://localhost:4222'
  if (!hasProtocol(natsUrl, ['nats:', 'tls:'])) {
    problems.push('NATS_URL must be a nats:// or tls:// URL.')
  }

  const portText = env.PORT?.trim() || '3001'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer from 1 to 65535, got "${portText}".`)
  }

  const host = env.HOST?.trim() || '127.0.0.1'

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n- ${problems.join('\n- ')}`)
  }
  return { databaseUrl: databaseUrl!, natsUrl, port, host }
}

function hasProtocol(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol)
  } catch {
    return false
  }
}
