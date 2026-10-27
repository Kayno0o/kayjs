import type { McpConfig } from './api-modules'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { kayLog } from '../runtime/log'

const KEY_VARIABLE = 'KAY_MCP_KEY'
const KEY_FILE_VARIABLE = 'KAY_MCP_KEY_FILE'

// Shorter keys are guessable, whatever compares them.
export const MCP_KEY_MIN = 16
const BEARER = /^bearer +(\S+)$/i

// What `mcp.key` asks for: `true` reads the environment, a string is the key, `{ file }` reads the environment and else that file, made on first use.
export type McpKeySetting = true | string | { file: string }

// The setting of `mcp`, or undefined while the endpoint is open to any client.
export function mcpKeySetting(value: boolean | McpConfig | undefined): McpKeySetting | undefined {
  const key = typeof value === 'object' ? value.key : undefined

  if (key === undefined || key === false)
    return undefined

  if (key === true || typeof key === 'string' || (typeof key === 'object' && key !== null && typeof key.file === 'string' && key.file !== ''))
    return key

  throw new KayError('config-invalid', 'kay: mcp.key is `true` (read KAY_MCP_KEY or KAY_MCP_KEY_FILE), the key as a string, or `{ file }` naming the file that holds it and is made on first use')
}

// The key every request to the endpoint must carry as a bearer token, or undefined when `mcp.key` is set and no key was given, which refuses every request.
// Read once, at boot: a rotated key takes effect on the next start.
export function resolveMcpKey(setting: McpKeySetting, options: { root: string, production: boolean }): string | undefined {
  if (typeof setting === 'string')
    return checked(setting.trim(), 'mcp.key')

  const given = fromEnvironment()

  if (given !== undefined)
    return given

  if (typeof setting === 'object')
    return checked(readOrMake(resolve(options.root, setting.file)), `the file ${setting.file}`)

  if (options.production)
    throw new KayError('config-invalid', `kay: mcp.key is set, which asks for a key read from ${KEY_VARIABLE} or from the file ${KEY_FILE_VARIABLE} names, and neither gives one`)

  // A test run sets its key through `testSite({ mcpKey })`, and warning there repeats in every test file.
  if (process.env.NODE_ENV !== 'test')
    kayLog('warn', `mcp.key is set but ${KEY_VARIABLE} and ${KEY_FILE_VARIABLE} are not, so the MCP endpoint refuses every request; a production server would not boot`)

  return undefined
}

function checked(key: string, source: string): string {
  if (key.length < MCP_KEY_MIN)
    throw new KayError('config-invalid', `kay: the MCP key from ${source} must be at least ${MCP_KEY_MIN} characters`)

  return key
}

// `KAY_MCP_KEY`, else the trimmed content of the file `KAY_MCP_KEY_FILE` names; a file named and not readable stops the boot rather than leave the endpoint open or shut by chance.
function fromEnvironment(): string | undefined {
  const given = process.env[KEY_VARIABLE]?.trim()

  if (given !== undefined && given !== '')
    return checked(given, KEY_VARIABLE)

  const file = process.env[KEY_FILE_VARIABLE]?.trim()

  if (file === undefined || file === '')
    return undefined

  try {
    return checked(readFileSync(file, 'utf8').trim(), `the file ${KEY_FILE_VARIABLE} names`)
  }
  catch (error) {
    if (error instanceof KayError)
      throw error

    throw new KayError('config-invalid', `kay: ${KEY_FILE_VARIABLE} names ${file}, which cannot be read`)
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

// The key in `path`, made on first use; one another process wrote first wins.
function readOrMake(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  }
  catch (error) {
    if (!isCode(error, 'ENOENT'))
      throw new KayError('config-invalid', `kay: the MCP key file ${path} cannot be read`)
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

  try {
    writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' })
  }
  catch (error) {
    if (!isCode(error, 'EEXIST'))
      throw error
  }

  return readFileSync(path, 'utf8').trim()
}

const digest = (text: string): Buffer => createHash('sha256').update(text).digest()

// Whether `request` carries `key` as its one bearer token: the scheme is read in any case, and both sides are hashed first so neither the content nor the length of the key shows in the time taken.
export function bearsMcpKey(request: Request, key: string): boolean {
  const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1]

  return token !== undefined && timingSafeEqual(digest(token), digest(key))
}
