export type Config = {
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
 * lists every invalid variable. The port variable is specific to this service,
 * because every service loads the same .env locally; NATS_URL and HOST are shared.
 */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = []

  const natsUrl = env.NATS_URL?.trim() || 'nats://localhost:4222'
  if (!hasProtocol(natsUrl, ['nats:', 'tls:'])) {
    problems.push('NATS_URL must be a nats:// or tls:// URL.')
  }

  const portText = env.SCAN_INGESTION_PORT?.trim() || '3002'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    problems.push(`SCAN_INGESTION_PORT must be an integer from 1 to 65535, got "${portText}".`)
  }

  const host = env.HOST?.trim() || '127.0.0.1'

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n- ${problems.join('\n- ')}`)
  }
  return { natsUrl, port, host }
}

function hasProtocol(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol)
  } catch {
    return false
  }
}
