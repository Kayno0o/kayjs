import type { Command } from './command'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { findUp } from '@kaynooo/cli-kit'
import { within } from '@kaynooo/utils/promise'
import { SQL } from 'bun'
import { Database } from 'bun:sqlite'
import { version as runningVersion } from '../../package.json'
import { KAY_DIR } from '../build/assets'
import { bunProblem } from '../bun'
import { loadConfigWithin } from '../config-loader'
import { readDevAddress } from '../dev/address'
import { loopbackTaken } from '../dev/loopback'
import { peerInstallCommand, PEERS } from '../peers'
import { sqlitePath } from '../server/app-database'
import { readManifest } from '../server/client'
import { buildingWithoutEnv } from '../server/env-state'
import { localeSettings } from '../server/i18n'
import { formatOption, isPort, printDocument, projectRoot, withStdoutOnStderr } from './command'
import { completionCheck } from './completion'
import { listEnv } from './env'

export interface Check {
  name: string
  ok: boolean
  message: string
  // Set on an ok check that is worth a look: shown as `warn`, and no reason for a failing exit code.
  warning?: boolean
  // What to run or change, on a failure.
  fix?: string
}

const KAY_PACKAGE = '@kayjs/kay'
const LIBRARY_PREFIX = '@kayjs/'
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
// The build directories kay writes a manifest into: `kay build` and `kay dev`, with the command that makes each again.
const BUILDS = [{ dir: `${KAY_DIR}/client`, fix: 'run `kay build`' }, { dir: `${KAY_DIR}/dev`, fix: 'restart `kay dev`' }]
// A manifest `kay dev` or `kay build` is writing reads as half a file: it is read again after this long before it counts as unreadable.
const MANIFEST_RETRY_MS = 150
// How long the database named by DATABASE_URL has to answer.
const DATABASE_TIMEOUT_S = 3
const DATABASE_FIX = 'start the database, or fix DATABASE_URL in the shell or in .env'
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' }
const DEFAULT_PORT = 3000
const LINE_BREAK = /\r?\n/
const ASSIGNMENT = /^(?:export\s+)?([A-Z_]\w*)\s*=(.*)$/i
const TRAILING_COMMENT = /\s+#.*$/
const QUOTED = /^(['"`])(.*)\1$/

// Everything that can keep a project from running, one check each: a fault is reported with what to do about it, and the others still run.
export const doctor: Command = {
  usage: 'doctor [dir] [--port <port>] [--format text|json] [--quiet]',
  options: { format: { type: 'string' }, port: { type: 'string' }, quiet: { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals: [path] }, refuse) => {
    const format = formatOption(refuse, values.format)

    if (format === undefined)
      return 2

    if (typeof values.port === 'string' && !isPort(values.port))
      return refuse(`--port takes a port number, not ${values.port}`)

    const root = projectRoot('doctor', path, format)

    if (root === undefined)
      return 1

    buildingWithoutEnv()

    const checks = await withStdoutOnStderr(async () => diagnose(root, typeof values.port === 'string' ? values.port : undefined))

    if (format === 'json')
      printDocument({ checks })
    else if (values.quiet !== true || checks.some(check => !check.ok))
      console.log(checks.filter(check => values.quiet !== true || !check.ok).map(formatCheck).join('\n'))

    return checks.every(check => check.ok) ? 0 : 1
  },
}

function formatCheck({ name, ok, message, warning, fix }: Check): string {
  const status = ok ? 'ok  ' : 'FAIL'

  return `${warning === true ? 'warn' : status} ${name.padEnd(8)} ${message}${fix === undefined ? '' : `\n${' '.repeat(14)}fix: ${fix}`}`
}

export async function diagnose(root: string, port?: string): Promise<Check[]> {
  const dotenv = dotenvOf(root)

  return [
    bunCheck(root),
    versionsCheck(root),
    peersCheck(root),
    tsconfigCheck(root),
    await configCheck(root),
    await envCheck(root, dotenv),
    await portCheck(root, port ?? process.env.PORT ?? dotenv.PORT ?? String(DEFAULT_PORT), process.env.HOST ?? dotenv.HOST),
    await buildCheck(root),
    await browserCheck(),
    await databaseCheck(dotenv.DATABASE_URL),
    completionCheck(),
  ]
}

function bunCheck(root: string): Check {
  const problem = bunProblem({ cwd: root })

  if (problem === undefined)
    return { name: 'bun', ok: true, message: `Bun ${Bun.version}` }

  const split = problem.lastIndexOf(': ')

  return { name: 'bun', ok: false, message: problem.slice(0, split), fix: problem.slice(split + 2) }
}

// The version installed in the project's node_modules or in one above it, where a workspace hoists it.
function installedVersion(root: string, name: string): string | undefined {
  const manifest = findUp(join('node_modules', name, 'package.json'), root)

  try {
    return manifest === undefined ? undefined : (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version
  }
  catch {
    return undefined
  }
}

function minorOf(version: string): string {
  return version.split('.').slice(0, 2).join('.')
}

// kay and the libraries the project lists, which must be on one minor: a library's peer on kay is a minor.
function versionsCheck(root: string): Check {
  let manifest: Partial<Record<(typeof DEPENDENCY_SECTIONS)[number], Record<string, string>>>

  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as typeof manifest
  }
  catch {
    return { name: 'versions', ok: false, message: 'package.json is missing or is not JSON', fix: 'run kay in the directory of the project, or give it as the argument' }
  }

  const listed = [...new Set(DEPENDENCY_SECTIONS.flatMap(section => Object.keys(manifest[section] ?? {})))].filter(name => name === KAY_PACKAGE || name.startsWith(LIBRARY_PREFIX)).sort()
  const absent = listed.filter(name => installedVersion(root, name) === undefined)

  if (absent.length > 0)
    return { name: 'versions', ok: false, message: `${absent.join(', ')} listed in package.json but not installed`, fix: 'run `bun install`' }

  const kay = installedVersion(root, KAY_PACKAGE) ?? runningVersion
  const apart = listed.filter(name => name !== KAY_PACKAGE && minorOf(installedVersion(root, name)!) !== minorOf(kay))

  if (apart.length > 0)
    return { name: 'versions', ok: false, message: `kay ${kay} with ${apart.map(name => `${name} ${installedVersion(root, name)}`).join(', ')}, not on its minor`, fix: `run \`bun update ${[KAY_PACKAGE, ...apart].join(' ')}\`, or \`kay upgrade\`` }

  const libraries = listed.filter(name => name !== KAY_PACKAGE)

  return { name: 'versions', ok: true, message: `kay ${kay}${libraries.length === 0 ? '' : ` with ${libraries.map(name => `${name} ${installedVersion(root, name)}`).join(', ')}`}` }
}

async function configCheck(root: string): Promise<Check> {
  try {
    const config = await loadConfigWithin(root)

    if (config.i18n !== undefined)
      localeSettings(config.i18n)

    return { name: 'config', ok: true, message: existsSync(join(root, 'kay.config.ts')) ? 'kay.config.ts loads' : 'no kay.config.ts, the defaults apply' }
  }
  catch (error) {
    return { name: 'config', ok: false, message: firstLine(error), fix: 'fix kay.config.ts, then `kay check` points at the line' }
  }
}

// The packages kay loads for its type checks and its accessibility checks are the app's to install, as dev dependencies: without the first `kay check` stops, without the second only `kay a11y` and the dev tool's a11y warnings are off, so it warns.
function peersCheck(root: string): Check {
  const absent = PEERS.filter(name => installedVersion(root, name) === undefined)

  if (absent.includes('typescript7'))
    return { name: 'peers', ok: false, message: 'typescript7 is not installed, so `kay check`, `kay dev` types and the editor server cannot run', fix: `run ${absent.map(name => `\`${peerInstallCommand(name)}\``).join(' and ')}` }

  if (absent.length > 0)
    return { name: 'peers', ok: true, warning: true, message: 'axe-core is not installed, so `kay a11y`, `page.a11y()` and the dev tool\'s a11y warnings are off', fix: `run \`${peerInstallCommand('axe-core')}\`` }

  return { name: 'peers', ok: true, message: PEERS.map(name => `${name} ${installedVersion(root, name)}`).join(', ') }
}

// The project's types are checked through its tsconfig.json, which a workspace may keep above the project.
function tsconfigCheck(root: string): Check {
  const found = findUp('tsconfig.json', root)

  return found === undefined
    ? { name: 'tsconfig', ok: false, message: 'no tsconfig.json in the project or above it', fix: 'add a tsconfig.json (`kay new` writes one), as `kay check` types the project through it' }
    : { name: 'tsconfig', ok: true, message: found === join(root, 'tsconfig.json') ? 'tsconfig.json found' : `${found} found` }
}

// Chrome or Chromium drive `kay screenshot`, `kay a11y` and `testSite({ browser })`; an app that uses none of them is no worse off without one, so a missing browser warns.
async function browserCheck(): Promise<Check> {
  const { browserPath } = await import('../test/browser')
  const found = browserPath()

  if (found !== undefined)
    return { name: 'browser', ok: true, message: found }

  const given = process.env.BUN_CHROME_PATH

  return { name: 'browser', ok: true, warning: true, message: `no Chrome or Chromium found${given === undefined || given === '' ? '' : ` (BUN_CHROME_PATH=${given} is none)`}`, fix: 'install one, or set BUN_CHROME_PATH to its path' }
}

// DATABASE_URL, from the shell or `.env`, must answer: Postgres a `select 1` within a few seconds, SQLite a file that opens read-only (a file not created yet is the first start's to make).
async function databaseCheck(fromDotenv: string | undefined): Promise<Check> {
  const url = process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === '' ? fromDotenv : process.env.DATABASE_URL

  if (url === undefined)
    return { name: 'database', ok: true, message: 'DATABASE_URL is not set' }

  const file = sqlitePath(url)

  try {
    if (file !== undefined) {
      if (!existsSync(file))
        return { name: 'database', ok: true, message: `${file} is created on first start` }

      const database = new Database(file, { readonly: true })

      try {
        database.query('select 1').get()
      }
      finally {
        database.close()
      }

      return { name: 'database', ok: true, message: `${file} opens` }
    }

    const sql = new SQL(url, { max: 1, connectionTimeout: DATABASE_TIMEOUT_S, idleTimeout: 1 })

    try {
      // A server that accepts the connection and never answers is bounded here, as `connectionTimeout` bounds only the connect.
      if (await within(Promise.resolve(sql`select 1`), DATABASE_TIMEOUT_S * 1000, 'timeout' as const) === 'timeout')
        return { name: 'database', ok: false, message: `DATABASE_URL did not answer within ${DATABASE_TIMEOUT_S} s`, fix: DATABASE_FIX }
    }
    finally {
      await within(sql.close(), DATABASE_TIMEOUT_S * 1000, 'timeout' as const)
    }

    return { name: 'database', ok: true, message: 'DATABASE_URL answers' }
  }
  catch (error) {
    return { name: 'database', ok: false, message: `DATABASE_URL does not answer: ${withoutSecrets(firstLine(error), url)}`, fix: DATABASE_FIX }
  }
}

// The url and its password, which a driver's error may echo, left out of a message that is printed and put in JSON.
function withoutSecrets(message: string, url: string): string {
  const secrets = [url]

  try {
    const { password } = new URL(url)

    if (password !== '')
      secrets.push(password, decodeURIComponent(password))
  }
  catch {}

  return secrets.reduce((text, secret) => text.replaceAll(secret, secret === url ? '<DATABASE_URL>' : '***'), message)
}

// The variables the project's `.env` files set, the first file winning as Bun reads them; a variable with no value counts as unset.
function dotenvOf(root: string): Record<string, string> {
  const mode = process.env.NODE_ENV ?? 'development'
  const files = [...mode === 'test' ? [] : ['.env.local'], `.env.${mode}.local`, `.env.${mode}`, '.env']
  const values: Record<string, string> = {}

  for (const file of files) {
    let text: string

    try {
      text = readFileSync(join(root, file), 'utf8')
    }
    catch {
      continue
    }

    for (const line of text.split(LINE_BREAK)) {
      const match = ASSIGNMENT.exec(line.trim())

      if (match === null)
        continue

      const raw = match[2]!.trim()
      const quoted = QUOTED.exec(raw)
      const value = quoted === null ? raw.replace(TRAILING_COMMENT, '') : quoted[2]!

      if (value !== '' && values[match[1]!] === undefined)
        values[match[1]!] = value
    }
  }

  return values
}

// The keys kay reads from a file when the variable itself is unset.
const FILE_KEYS = new Set(['KAY_PROXY_KEY', 'KAY_MCP_KEY'])

async function envCheck(root: string, dotenv: Record<string, string>): Promise<Check> {
  try {
    const { variables, unread } = await listEnv(root)
    const production = process.env.NODE_ENV === 'production'
    const needed = (required: string | false) => required === 'always' || (production && required === 'production')
    const isSet = (name: string) => (process.env[name] ?? '') !== '' || dotenv[name] !== undefined
    const unset = variables.filter(variable => needed(variable.required) && !isSet(variable.name) && !(FILE_KEYS.has(variable.name) && isSet(`${variable.name}_FILE`))).map(variable => variable.name)

    if (unset.length > 0)
      return { name: 'env', ok: false, message: `${unset.join(', ')} declared and required, but not set`, fix: `set ${unset.length === 1 ? 'it' : 'them'} in the shell or in .env (\`kay env\` lists every variable)` }

    const skipped = unread.length === 0 ? '' : `; ${unread.map(({ file }) => file).join(', ')} could not be read to list its variables (\`kay env\`)`

    return { name: 'env', ok: true, message: `${variables.filter(variable => variable.required === 'always').length} required variables, all set${skipped}` }
  }
  catch (error) {
    return { name: 'env', ok: false, message: `the declared variables could not be listed: ${firstLine(error)}`, fix: 'fix the config or the module `kay env` names' }
  }
}

// `kay dev` listens on both loopback addresses whatever HOST says, and a server of the app on HOST when it is set, else on every IPv4 address, so the probe binds HOST or else each of those.
async function portCheck(root: string, port: string, host?: string): Promise<Check> {
  if (!isPort(port))
    return { name: 'port', ok: false, message: `${port} is no port number`, fix: 'set PORT, or pass --port, to a number up to 65535' }

  if (Number(port) === 0)
    return { name: 'port', ok: true, message: 'PORT 0 lets the system pick a free port' }

  const dev = readDevAddress(root)

  if (dev !== undefined && devPort(dev) === String(Number(port)))
    return { name: 'port', ok: true, message: `${port} is held by this project's kay dev` }

  try {
    if (host === undefined && loopbackTaken(Number(port)))
      throw Object.assign(new Error('taken on a loopback address'), { code: 'EADDRINUSE' })

    const server = Bun.serve({ port: Number(port), ...host !== undefined && { hostname: host }, fetch: () => new Response() })

    await server.stop(true)

    return { name: 'port', ok: true, message: `${port} is free` }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      return { name: 'port', ok: false, message: `${port} is already in use`, fix: 'stop what holds it, or pick another with PORT or `--port`' }

    return { name: 'port', ok: false, message: `${port} cannot be listened on: ${firstLine(error)}`, fix: 'pick another with PORT or `--port`, or set HOST to an address of this machine' }
  }
}

function devPort(address: string): string {
  const url = new URL(address)

  return url.port === '' ? DEFAULT_PORTS[url.protocol] ?? '' : url.port
}

export async function manifestOf(root: string, dir: string, wait: (ms: number) => Promise<unknown> = Bun.sleep) {
  try {
    return await readManifest(root, join(root, dir))
  }
  catch {
    await wait(MANIFEST_RETRY_MS)

    return readManifest(root, join(root, dir))
  }
}

// The builds in `.kay` are stamped with the kay that wrote them; one by another kay, or by one before the stamp, is rebuilt.
async function buildCheck(root: string): Promise<Check> {
  const built: string[] = []

  for (const { dir, fix } of BUILDS) {
    try {
      const manifest = await manifestOf(root, dir)

      if (manifest === undefined)
        continue

      if (manifest.kay !== runningVersion)
        return { name: 'build', ok: false, message: `${dir} was built by ${manifest.kay === undefined ? 'a kay before builds were stamped' : `kay ${manifest.kay}`}, this is kay ${runningVersion}`, fix }

      built.push(dir)
    }
    catch {
      return { name: 'build', ok: false, message: `${dir}/manifest.json cannot be read`, fix }
    }
  }

  return { name: 'build', ok: true, message: built.length === 0 ? 'not built yet' : `${built.join(' and ')} built by this kay` }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const end = message.indexOf('\n')

  return end === -1 ? message : message.slice(0, end)
}
