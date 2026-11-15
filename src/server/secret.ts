import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { KayError } from '../compiler/errors'

// A secret as the config gives it: the value itself, the environment variable that holds it, or the file that does.
export type Secret = string | { env: string } | { file: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// Refuses a secret of another shape, naming the key it was set under.
export function checkSecret(value: unknown, name: string, or?: string): Secret {
  if (typeof value === 'string')
    return value

  if (isRecord(value) && Object.keys(value).length === 1) {
    if (typeof value.env === 'string' && value.env !== '')
      return { env: value.env }

    if (typeof value.file === 'string' && value.file !== '')
      return { file: value.file }
  }

  throw new KayError('config-invalid', `kay: ${name} is a string, \`{ env }\` naming the variable that holds it, or \`{ file }\` naming the file that does${or === undefined ? '' : `, or ${or}`}`)
}

// The text of a secret, trimmed, or undefined when it is empty, the variable unset or the file missing or unreadable. A relative `{ file }` resolves against `root`, the working directory by default.
export function readSecret(secret: Secret, root: string = process.cwd()): string | undefined {
  let text: string | undefined

  if (typeof secret === 'string') {
    text = secret
  }
  else if ('env' in secret) {
    text = process.env[secret.env]
  }
  else {
    try {
      text = readFileSync(resolve(root, secret.file), 'utf8')
    }
    catch {
      return undefined
    }
  }

  const trimmed = text?.trim()

  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

// The environment variables the secrets of `proxy.key`, `mcp.token` and `metrics.token` name, which a build that starts the server stands in for.
export function secretVariables(config: { proxy?: unknown, mcp?: unknown, ops?: { metrics?: unknown } | undefined }): string[] {
  const named = (value: unknown): string[] => isRecord(value) && typeof value.env === 'string' ? [value.env] : []
  const proxy = isRecord(config.proxy) && isRecord(config.proxy.key) ? config.proxy.key.secret : undefined
  const mcp = isRecord(config.mcp) ? config.mcp.token : undefined
  const metrics = isRecord(config.ops?.metrics) ? config.ops.metrics.token : undefined

  return [proxy, mcp, metrics].flatMap(named)
}

const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/

// Refuses a `proxy.key` that is no `{ header, secret? }`.
export function checkProxyKey(key: unknown): void {
  if (!isRecord(key) || typeof key.header !== 'string' || !HEADER_NAME.test(key.header))
    throw new KayError('config-invalid', 'kay: proxy.key is `{ header }` naming the header the proxy sends its shared key in, such as `{ header: \'x-upstream-key\' }`, with the key as `secret` when it is not in KAY_PROXY_KEY')

  if (key.secret !== undefined)
    checkSecret(key.secret, 'proxy.key.secret')
}

// Where a secret is read from, for a message.
export function secretSource(secret: Secret): string {
  if (typeof secret === 'string')
    return 'its value'

  return 'env' in secret ? secret.env : `the file ${secret.file}`
}
