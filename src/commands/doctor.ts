import type { Command } from './command'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { version as runningVersion } from '../../package.json'
import { bunProblem } from '../bun'
import { loadConfig } from '../config'
import { readDevAddress } from '../dev/address'
import { readManifest } from '../server/client'
import { formatOption, isPort, printDocument, projectRoot, withStdoutOnStderr } from './command'
import { listEnv } from './env'
import { USAGES } from './usages'

export interface Check {
  name: string
  ok: boolean
  message: string
  // What to run or change, on a failure.
  fix?: string
}

const KAY_PACKAGE = '@kaynooo/kayjs'
const LIBRARY_PREFIX = '@kaynooo/kayjs-'
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
// The build directories kay writes a manifest into: `kay build` and `kay dev`, with the command that makes each again.
const BUILDS = [{ dir: '.kay/client', fix: 'run `kay build`' }, { dir: '.kay/dev', fix: 'restart `kay dev`' }]
const DEFAULT_PORT = 3000
const LINE_BREAK = /\r?\n/
const ASSIGNMENT = /^(?:export\s+)?([A-Z_]\w*)\s*=(.*)$/i
const TRAILING_COMMENT = /\s+#.*$/
const QUOTED = /^(['"`])(.*)\1$/

// Everything that can keep a project from running, one check each: a fault is reported with what to do about it, and the others still run.
export const doctor: Command = {
  usage: USAGES.doctor,
  options: { format: { type: 'string' }, port: { type: 'string' } },
  positionals: 1,
  run: async ({ values, positionals: [path] }, refuse) => {
    const format = formatOption('doctor', values.format)

    if (format === undefined)
      return 1

    if (typeof values.port === 'string' && !isPort(values.port))
      return refuse(`--port takes a port number, not ${values.port}`)

    const root = projectRoot('doctor', path, format)

    if (root === undefined)
      return 1

    const checks = await withStdoutOnStderr(async () => diagnose(root, typeof values.port === 'string' ? values.port : undefined))

    if (format === 'json')
      printDocument({ checks })
    else
      console.log(checks.map(formatCheck).join('\n'))

    return checks.every(check => check.ok) ? 0 : 1
  },
}

function formatCheck({ name, ok, message, fix }: Check): string {
  return `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(8)} ${message}${fix === undefined ? '' : `\n${' '.repeat(14)}fix: ${fix}`}`
}

export async function diagnose(root: string, port?: string): Promise<Check[]> {
  const dotenv = dotenvOf(root)

  return [
    bunCheck(),
    versionsCheck(root),
    await configCheck(root),
    await envCheck(root, dotenv),
    await portCheck(root, port ?? process.env.PORT ?? dotenv.PORT ?? String(DEFAULT_PORT)),
    await buildCheck(root),
  ]
}

function bunCheck(): Check {
  const problem = bunProblem()

  return problem === undefined ? { name: 'bun', ok: true, message: `Bun ${Bun.version}` } : { name: 'bun', ok: false, message: problem, fix: problem.slice(problem.lastIndexOf(': ') + 2) }
}

function installedVersion(root: string, name: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string }).version
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
    await loadConfig(root)

    return { name: 'config', ok: true, message: existsSync(join(root, 'kay.config.ts')) ? 'kay.config.ts loads' : 'no kay.config.ts, the defaults apply' }
  }
  catch (error) {
    return { name: 'config', ok: false, message: firstLine(error), fix: 'fix kay.config.ts, then `kay check` points at the line' }
  }
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

async function envCheck(root: string, dotenv: Record<string, string>): Promise<Check> {
  try {
    const { variables, unread } = await listEnv(root)
    const production = process.env.NODE_ENV === 'production'
    const needed = (required: string | false) => required === 'always' || (production && required === 'production')
    const unset = variables.filter(variable => needed(variable.required) && (process.env[variable.name] ?? '') === '' && dotenv[variable.name] === undefined).map(variable => variable.name)

    if (unset.length > 0)
      return { name: 'env', ok: false, message: `${unset.join(', ')} declared and required, but not set`, fix: `set ${unset.length === 1 ? 'it' : 'them'} in the shell or in .env (\`kay env\` lists every variable)` }

    const skipped = unread.length === 0 ? '' : `; ${unread.map(({ file }) => file).join(', ')} could not be read to list its variables (\`kay env\`)`

    return { name: 'env', ok: true, message: `${variables.filter(variable => variable.required === 'always').length} required variables, all set${skipped}` }
  }
  catch (error) {
    return { name: 'env', ok: false, message: `the declared variables could not be listed: ${firstLine(error)}`, fix: 'fix the config or the module `kay env` names' }
  }
}

async function portCheck(root: string, port: string): Promise<Check> {
  if (!isPort(port))
    return { name: 'port', ok: false, message: `${port} is no port number`, fix: 'set PORT, or pass --port, to a number up to 65535' }

  const dev = readDevAddress(root)

  if (dev !== undefined && new URL(dev).port === port)
    return { name: 'port', ok: true, message: `${port} is held by this project's kay dev` }

  try {
    const server = Bun.serve({ port: Number(port), hostname: process.env.HOST ?? '0.0.0.0', fetch: () => new Response() })

    await server.stop(true)

    return { name: 'port', ok: true, message: `${port} is free` }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      return { name: 'port', ok: false, message: `${port} is already in use`, fix: 'stop what holds it, or pick another with PORT or `--port`' }

    return { name: 'port', ok: false, message: `${port} cannot be listened on: ${firstLine(error)}`, fix: 'pick another with PORT or `--port`, or set HOST to an address of this machine' }
  }
}

// The builds in `.kay` are stamped with the kay that wrote them; one by another kay, or by one before the stamp, is rebuilt.
async function buildCheck(root: string): Promise<Check> {
  const built: string[] = []

  for (const { dir, fix } of BUILDS) {
    try {
      const manifest = await readManifest(root, join(root, dir))

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
