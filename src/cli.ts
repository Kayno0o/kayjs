#!/usr/bin/env bun
import type { ParseArgsOptionsConfig } from 'node:util'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { KayCompileError } from './build/transform'
import { check, formatCheckDiagnostic } from './check'
import { formatDiagnostic } from './compiler'
import { loadConfig } from './config'
import { dev } from './dev'
import { formatFiles } from './format'
import { startServer } from './lsp/server'
import { createProject } from './new'
import { buildClient } from './server/client'
import { prerenderPages } from './server/prerender'

const SHELL_SAFE = /^[\w@%+=:,./-]+$/
const USAGE = 'Usage: kay new <dir> [--kay <dependency>]\n       kay dev [entry]\n       kay build [dir]\n       kay check [dir] [-p tsconfig.json]\n       kay fmt [paths...] [--check]\n       kay lsp --stdio'

interface Parsed {
  values: Record<string, string | boolean | undefined>
  positionals: string[]
}

// What a command's arguments hold, or the exit code once the usage was printed: to stdout for `--help`, to stderr for an option or argument the command does not take.
function parseCommand(args: string[], options: ParseArgsOptionsConfig, maxPositionals: number): Parsed | number {
  try {
    const { values, positionals } = parseArgs({ args, options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals: true })

    if (values.help) {
      console.log(USAGE)

      return 0
    }

    if (positionals.length > maxPositionals)
      throw new Error(`unexpected argument ${positionals[maxPositionals]}`)

    return { values, positionals }
  }
  catch (error) {
    console.error(`kay: ${error instanceof Error ? error.message : error}\n${USAGE}`)

    return 1
  }
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args

  if (command === '--help' || command === '-h') {
    console.log(USAGE)

    return 0
  }

  if (command === 'lsp') {
    const parsed = parseCommand(rest, { stdio: { type: 'boolean' } }, 0)

    if (typeof parsed === 'number')
      return parsed

    await startServer(Bun.stdin.stream(), data => void process.stdout.write(data))

    return 0
  }

  if (command === 'fmt')
    return fmt(rest)

  if (command === 'dev')
    return runDev(rest)

  if (command === 'build')
    return build(rest)

  if (command === 'new')
    return scaffold(rest)

  if (command !== 'check') {
    console.error(USAGE)

    return 1
  }

  return runCheck(rest)
}

async function runCheck(args: string[]): Promise<number> {
  const parsed = parseCommand(args, { project: { type: 'string', short: 'p' } }, 1)

  if (typeof parsed === 'number')
    return parsed

  const tsconfig = typeof parsed.values.project === 'string' ? parsed.values.project : 'tsconfig.json'
  const root = resolve(parsed.positionals[0] ?? '.')
  const { routes, publicDir } = await loadConfig(root)
  const diagnostics = await check(root, { tsconfig, routes, publicDir })

  const sources = new Map<string, string | undefined>()

  for (const diagnostic of diagnostics) {
    if (!sources.has(diagnostic.file))
      sources.set(diagnostic.file, await readSource(diagnostic.file))

    console.error(`${formatCheckDiagnostic(diagnostic, sources.get(diagnostic.file))}\n`)
  }

  if (diagnostics.length > 0)
    console.error(`${diagnostics.length} error${diagnostics.length === 1 ? '' : 's'}`)

  return diagnostics.length > 0 ? 1 : 0
}

// Bundles the browser code for production, minified unless kay.config.ts says otherwise, and renders the pages marked `prerender`; the server then boots without bundling.
async function build(args: string[]): Promise<number> {
  const parsed = parseCommand(args, {}, 1)

  if (typeof parsed === 'number')
    return parsed

  const root = resolve(parsed.positionals[0] ?? '.')
  const config = await loadConfig(root)
  const started = performance.now()

  try {
    const client = await buildClient(root, { minify: config.minify ?? true, plugins: config.plugins, routes: config.routes })
    const prerendered = await prerenderPages(root, config, client)

    console.error(`built ${count(Object.keys(client.islands).length, 'island')}, ${count(client.styles.size, 'stylesheet')} and ${count(prerendered, 'prerendered page')} in ${Math.round(performance.now() - started)} ms`)

    return 0
  }
  catch (error) {
    console.error(error instanceof KayCompileError ? error.message.trimStart() : error)

    return 1
  }
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`
}

async function scaffold(args: string[]): Promise<number> {
  const parsed = parseCommand(args, { kay: { type: 'string' } }, 1)

  if (typeof parsed === 'number')
    return parsed

  const dir = parsed.positionals[0]

  if (!dir) {
    console.error(USAGE)

    return 1
  }

  try {
    const files = await createProject(dir, { kay: typeof parsed.values.kay === 'string' ? parsed.values.kay : undefined })

    console.error(`${files.map(file => `created ${join(dir, file)}`).join('\n')}\n\ncd ${shellQuote(dir)} && bun install && bun run dev`)

    return 0
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : error)

    return 1
  }
}

// A path pasted into a shell line, quoted when it holds anything the shell would read.
function shellQuote(path: string): string {
  return SHELL_SAFE.test(path) ? path : `'${path.replaceAll('\'', '\'\\\'\'')}'`
}

// Restarts the server on every change until interrupted.
async function runDev(args: string[]): Promise<number> {
  const parsed = parseCommand(args, {}, 1)

  if (typeof parsed === 'number')
    return parsed

  const { routes, publicDir } = await loadConfig(process.cwd())
  const stop = await dev(process.cwd(), { entry: parsed.positionals[0], routes, publicDir })
  const { promise, resolve: interrupted } = Promise.withResolvers<void>()

  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  await promise
  await stop()

  return 0
}

// A diagnostic can point at a file that is gone by now, such as a tsconfig tsgo could not read.
async function readSource(file: string): Promise<string | undefined> {
  try {
    return await Bun.file(file).text()
  }
  catch {
    return undefined
  }
}

// Formats in place, or with `--check` lists the files that are not formatted and fails.
async function fmt(args: string[]): Promise<number> {
  const parsed = parseCommand(args, { check: { type: 'boolean' } }, Infinity)

  if (typeof parsed === 'number')
    return parsed

  const write = !parsed.values.check
  const { positionals: paths } = parsed
  let result: Awaited<ReturnType<typeof formatFiles>>

  try {
    result = await formatFiles(paths.length > 0 ? paths : ['.'], { write })
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : error)

    return 1
  }

  const { changed, errors } = result

  for (const { file, source, diagnostics } of errors) {
    for (const diagnostic of diagnostics)
      console.error(`${formatDiagnostic(source, relative(process.cwd(), file), diagnostic)}\n`)
  }

  for (const file of changed)
    console.error(`${write ? 'formatted' : 'not formatted'}: ${relative(process.cwd(), file)}`)

  return errors.length > 0 || (!write && changed.length > 0) ? 1 : 0
}

process.exit(await main(process.argv.slice(2)))
