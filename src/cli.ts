#!/usr/bin/env bun
import type { ParseArgsOptionsConfig } from 'node:util'
import type { Paint } from './compiler/frame'
import type { KayConfig } from './config'
import type { Template } from './new'
import type { ClientBuild } from './server/client'
import { existsSync, statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs, styleText } from 'node:util'
import { compileServer } from './build/compile'
import { exportStatic, refuseStaticConfig } from './build/static'
import { KayCompileError } from './build/transform'
import { applySafeFixes, check, formatCheckDiagnostic } from './check'
import { formatDiagnostic } from './compiler'
import { explainLint, isLint, lintList } from './compiler/lints'
import { loadConfig } from './config'
import { writeContentManifests } from './content/server'
import { ContentError } from './content/validate'
import { dev } from './dev'
import { formatFiles } from './format'
import { startServer } from './lsp/server'
import { migrateAstroProject } from './migrate/project'
import { createProject, TEMPLATES } from './new'
import { linkVariantFiles } from './runtime/image'
import { basePath } from './server/base'
import { writeCards } from './server/card'
import { buildClient, PRERENDERED_DIR } from './server/client'
import { compressFiles } from './server/compress'
import { buildingWithoutEnv } from './server/env'
import { FAVICON_DIR, writeFavicons } from './server/favicon'
import { writeImageVariants, writeRemoteVariants } from './server/image'
import { ExportError, prerenderPages } from './server/prerender'
import { remoteImages, remotePatterns } from './server/remote'

const SHELL_SAFE = /^[\w@%+=:,./-]+$/
// Colours a report as rustc does when stderr is a terminal that takes colours, and leaves it plain otherwise.
const toStderr: Paint = (styles, text) => styleText(styles, text, { stream: process.stderr })
const USAGE = 'Usage: kay new <dir> [--kay <dependency>] [--template server|site|app]\n       kay dev [dir] [--entry <file>]\n       kay build [dir] [--compile <executable>] [--entry <file>] [--static] [--outdir <dir>] [--no-check] [-p tsconfig.json]\n       kay check [dir] [-p tsconfig.json] [--entry <file>] [--deny-warnings] [--fix]\n       kay explain [lint]\n       kay fmt [paths...] [--check]\n       kay migrate astro [dir] [--out <dir>]\n       kay lsp --stdio'

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

    // An editor's machine lacks the server's environment, as `kay build` does, which kay.config.ts may import.
    buildingWithoutEnv()
    await startServer(Bun.stdin.stream(), data => void process.stdout.write(data))

    return 0
  }

  if (command === 'fmt')
    return fmt(rest)

  if (command === 'explain')
    return explain(rest)

  if (command === 'dev')
    return runDev(rest)

  if (command === 'build')
    return build(rest)

  if (command === 'new')
    return scaffold(rest)

  if (command === 'migrate')
    return migrate(rest)

  if (command !== 'check') {
    console.error(USAGE)

    return 1
  }

  return runCheck(rest)
}

// Lists the lints, or explains the one named.
function explain(args: string[]): number {
  const parsed = parseCommand(args, {}, 1)

  if (typeof parsed === 'number')
    return parsed

  const [name] = parsed.positionals

  if (name === undefined) {
    console.log(lintList())

    return 0
  }

  if (!isLint(name)) {
    console.error(`kay explain: \`${name}\` is no lint; \`kay explain\` lists them`)

    return 1
  }

  console.log(explainLint(name))

  return 0
}

async function runCheck(args: string[]): Promise<number> {
  const parsed = parseCommand(args, { 'project': { type: 'string', short: 'p' }, 'entry': { type: 'string' }, 'deny-warnings': { type: 'boolean' }, 'fix': { type: 'boolean' } }, 1)

  if (typeof parsed === 'number')
    return parsed

  const { project, entry } = parsed.values
  const tsconfig = typeof project === 'string' ? project : 'tsconfig.json'
  const root = projectRoot('check', parsed.positionals[0])

  if (root === undefined)
    return 1

  // The checking machine lacks the server's environment, as `kay build` does, which kay.config.ts may import.
  buildingWithoutEnv()

  return await checkProject(root, await loadConfig(root), tsconfig, typeof entry === 'string' ? relative(root, resolve(entry)) : undefined, { denyWarnings: parsed.values['deny-warnings'] === true, fix: parsed.values.fix === true }) > 0 ? 1 : 0
}

// Prints what `kay check` finds in the project, as it finds it, and answers how many of those problems fail it: the errors, and the warnings too with `denyWarnings`.
// With `fix`, applies the safe fixes first, then checks again and prints what is left.
async function checkProject(root: string, config: KayConfig, tsconfig: string, entry?: string, { denyWarnings = false, fix = false } = {}): Promise<number> {
  const { routes, publicDir, api, content, redirects, i18n, settings, base, site, shutdownTimeout, lints } = config
  const options = { tsconfig, entry, routes, publicDir, api, content, redirects, i18n, settings, base, site, shutdownTimeout, lints }
  let diagnostics = await check(root, options)
  const fixed = fix ? await applySafeFixes(root, diagnostics) : 0

  if (fixed > 0) {
    console.error(`kay check: fixed ${count(fixed, 'problem')}\n`)
    diagnostics = await check(root, options)
  }

  const sources = new Map<string, string | undefined>()

  for (const diagnostic of diagnostics) {
    if (!sources.has(diagnostic.file))
      sources.set(diagnostic.file, await readSource(diagnostic.file))

    console.error(`${formatCheckDiagnostic(diagnostic, sources.get(diagnostic.file), toStderr)}\n`)
  }

  const warnings = diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length
  const errors = diagnostics.length - warnings

  if (diagnostics.length > 0)
    console.error([errors > 0 ? count(errors, 'error') : '', warnings > 0 ? `${count(warnings, 'warning')}${denyWarnings ? ', failing the check under --deny-warnings' : ''}` : ''].filter(part => part !== '').join(', '))

  return errors + (denyWarnings ? warnings : 0)
}

// Bundles the browser code for production, minified unless kay.config.ts says otherwise, and renders the pages marked `prerender`; the server then boots without bundling.
// It checks the project as `kay check` does while it bundles for the browser, runs no page, API module or guard until that passed, and leaves the last build in place when either fails, unless `--no-check` says not to check.
// With `--compile`, also bundles the server and all of it into one executable; with `--static`, writes the whole site to `--outdir`, `dist` by default, for a host with no server.
async function build(args: string[]): Promise<number> {
  const parsed = parseCommand(args, { 'compile': { type: 'string' }, 'entry': { type: 'string' }, 'static': { type: 'boolean' }, 'outdir': { type: 'string' }, 'no-check': { type: 'boolean' }, 'project': { type: 'string', short: 'p' } }, 1)

  if (typeof parsed === 'number')
    return parsed

  const { compile, entry, outdir, project } = parsed.values
  const exported = parsed.values.static === true
  const skipCheck = parsed.values['no-check'] === true

  if (skipCheck && typeof project === 'string') {
    console.error(`kay: -p names the tsconfig the build checks with, so it does not go with --no-check\n${USAGE}`)

    return 1
  }

  if (typeof entry === 'string' && typeof compile !== 'string') {
    console.error(`kay: --entry names the server an executable runs, so it goes with --compile\n${USAGE}`)

    return 1
  }

  if (exported && typeof compile === 'string') {
    console.error(`kay: --static writes files for a host with no server, and --compile a server; pick one\n${USAGE}`)

    return 1
  }

  if (typeof outdir === 'string' && !exported) {
    console.error(`kay: --outdir names where --static writes the site, so it goes with --static\n${USAGE}`)

    return 1
  }

  const root = projectRoot('build', parsed.positionals[0])

  if (root === undefined)
    return 1

  buildingWithoutEnv()

  const config = await loadConfig(root)

  const output = join(root, '.kay', 'client')
  const previous = `${output}-previous`
  const checking = !skipCheck

  // The last build waits aside until this one is known good, which the check decides beside the browser bundle.
  if (checking)
    await setAside(output, previous)
  else
    await rm(previous, { recursive: true, force: true })

  const started = performance.now()
  const [checked, bundled] = await Promise.allSettled([checking ? checkProject(root, config, typeof project === 'string' ? project : 'tsconfig.json', typeof entry === 'string' ? relative(root, resolve(entry)) : undefined) : 0, bundleClient(root, config, exported)])

  if (checked.status === 'rejected' || checked.value > 0) {
    await putBack(output, previous)

    if (checked.status === 'rejected')
      throw checked.reason

    console.error('kay build: nothing built, as kay check found the problems above; --no-check builds anyway')

    return 1
  }

  let client: ClientBuild

  try {
    if (bundled.status === 'rejected')
      throw bundled.reason

    client = bundled.value

    const { prerendered, entries } = await finishOutput(root, config, exported, client)

    console.error(`built ${count(Object.keys(client.islands).length, 'island')}, ${count(client.styles.size, 'stylesheet')} and ${count(prerendered, 'prerendered page')}${entries > 0 ? ` from ${entries} content ${entries === 1 ? 'entry' : 'entries'}` : ''} in ${Math.round(performance.now() - started)} ms`)
  }
  catch (error) {
    if (checking)
      await putBack(output, previous)

    console.error(buildError(error))

    return 1
  }

  await rm(previous, { recursive: true, force: true })

  try {
    if (exported) {
      const written = performance.now()
      const target = resolve(typeof outdir === 'string' ? outdir : join(root, 'dist'))
      const site = await exportStatic(root, config, client, target)

      console.error(`exported ${count(site.pages, 'page')} and ${count(site.files, 'other file')} to ${relative(process.cwd(), target) || '.'} in ${Math.round(performance.now() - written)} ms`)
    }

    if (typeof compile === 'string') {
      const compiled = performance.now()
      const executable = await compileServer(root, config, { outfile: resolve(compile), entry: typeof entry === 'string' ? resolve(entry) : undefined })

      console.error(`compiled ${relative(process.cwd(), executable)} in ${Math.round(performance.now() - compiled)} ms`)
    }

    return 0
  }
  catch (error) {
    console.error(buildError(error))

    return 1
  }
}

// An output set aside earlier is the last good build of a run that was interrupted, and what is in its place now is that run's partial one.
async function setAside(output: string, previous: string) {
  if (existsSync(previous))
    await rm(output, { recursive: true, force: true })
  else if (existsSync(output))
    await rename(output, previous)
}

async function putBack(output: string, previous: string) {
  await rm(output, { recursive: true, force: true })

  if (existsSync(previous))
    await rename(previous, output)
}

function buildError(error: unknown): unknown {
  return error instanceof KayCompileError || error instanceof ContentError || error instanceof ExportError ? error.message.trimStart() : error
}

// The browser bundles and the variants of the images they import, which run no page, API module or guard, so they build while the check runs.
async function bundleClient(root: string, config: KayConfig, exported: boolean): Promise<ClientBuild> {
  if (exported)
    refuseStaticConfig(config)

  const client = await buildClient(root, { minify: config.minify ?? true, plugins: config.plugins, routes: config.routes, api: config.api, navigation: config.navigation, base: basePath(config.base), settings: config.settings, publicEnv: config.publicEnv !== undefined })

  // The prerender may import more images, so the cache is pruned once it has.
  await writeImageVariants(client.dir, config.images?.quality, join(root, '.kay', 'cache', 'variants'), { prune: false })

  return client
}

// The rest of what the server serves from `.kay/client`, which runs the app's content config and pages, so only once the check passed: content manifests, prerendered pages, the variants of images only they import, and favicons, compressed.
async function finishOutput(root: string, config: KayConfig, exported: boolean, client: ClientBuild): Promise<{ prerendered: number, entries: number }> {
  // Before prerendering, whose pages read the collections from what it writes.
  const entries = await writeContentManifests(root, join(root, '.kay', 'client'), config.content)

  // A static host has no image route, so pages link the variant files the build writes.
  if (exported)
    linkVariantFiles()

  const prerendered = await prerenderPages(root, config, client, { exportAll: exported })

  // Remote originals are kept between builds, revalidated as the image route does.
  const remote = remoteImages(join(root, '.kay', 'cache', 'remote'), remotePatterns(config.images?.remote))

  await writeImageVariants(client.dir, config.images?.quality, join(root, '.kay', 'cache', 'variants'))
  await writeRemoteVariants(client.dir, remote, config.images?.quality)
  await writeCards(client.dir, join(root, '.kay', 'cache', 'cards'), remote)

  if (config.favicon !== undefined)
    await writeFavicons(resolve(root, config.favicon), join(client.dir, '..', FAVICON_DIR))

  await Promise.all([compressFiles(client.dir), compressFiles(join(root, '.kay', 'client', PRERENDERED_DIR))])

  return { prerendered, entries }
}

// The directory a command works on, or nothing once it said that the path is none.
function projectRoot(command: string, path = '.'): string | undefined {
  const root = resolve(path)

  if (statSync(root, { throwIfNoEntry: false })?.isDirectory())
    return root

  console.error(`kay ${command}: ${path} is not a directory`)

  return undefined
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`
}

async function scaffold(args: string[]): Promise<number> {
  const parsed = parseCommand(args, { kay: { type: 'string' }, template: { type: 'string' } }, 1)

  if (typeof parsed === 'number')
    return parsed

  const dir = parsed.positionals[0]

  if (!dir) {
    console.error(USAGE)

    return 1
  }

  try {
    const { template } = parsed.values

    if (template !== undefined && !TEMPLATES.includes(template as Template)) {
      console.error(`kay new: --template is ${String(template)}, which is none of ${TEMPLATES.join(', ')}`)

      return 1
    }

    const files = await createProject(dir, { kay: typeof parsed.values.kay === 'string' ? parsed.values.kay : undefined, template: template as Template | undefined })

    // An app's database runs in the container its compose.dev.yaml describes, migrated before the first start.
    console.error(`${files.map(file => `created ${join(dir, file)}`).join('\n')}\n\ncd ${shellQuote(dir)} && bun install && ${template === 'app' ? 'docker compose up -d --wait && bun run db:migrate && ' : ''}bun run dev`)

    return 0
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : error)

    return 1
  }
}

// Translates an Astro project's `.astro` files and content config, in place or into `--out`, and lists what is left to do by hand.
async function migrate(args: string[]): Promise<number> {
  const parsed = parseCommand(args, { out: { type: 'string' } }, 2)

  if (typeof parsed === 'number')
    return parsed

  const [from, dir = '.'] = parsed.positionals

  if (from !== 'astro') {
    console.error(`kay migrate: ${from === undefined ? 'name what to migrate from' : `${from} is not something kay migrates from`}, as in \`kay migrate astro\``)

    return 1
  }

  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`kay migrate: ${dir} is not a directory`)

    return 1
  }

  const out = typeof parsed.values.out === 'string' ? resolve(parsed.values.out) : resolve(dir)
  const { written, skipped, notes } = await migrateAstroProject(resolve(dir), out)
  const shown = (file: string) => relative(process.cwd(), join(out, file)) || '.'

  for (const file of written)
    console.error(`wrote ${shown(file)}`)

  for (const file of skipped)
    console.error(`kept ${shown(file)}, which exists`)

  if (notes.length > 0)
    console.log(`\nLeft to do by hand, the code it concerns marked \`kay migrate:\` where it was commented out:\n${notes.map(each => `${relative(process.cwd(), join(dir, each.file))}:${each.line}${each.target === undefined ? '' : ` (${shown(each.target)})`}: ${each.message}`).join('\n')}`)

  console.error(`\n${count(written.length, 'file')} written, ${count(notes.length, 'item')} left to do by hand`)

  return 0
}

// A path pasted into a shell line, quoted when it holds anything the shell would read.
function shellQuote(path: string): string {
  return SHELL_SAFE.test(path) ? path : `'${path.replaceAll('\'', '\'\\\'\'')}'`
}

// Restarts the server on every change until interrupted.
async function runDev(args: string[]): Promise<number> {
  const parsed = parseCommand(args, { entry: { type: 'string' } }, 1)

  if (typeof parsed === 'number')
    return parsed

  const [path] = parsed.positionals
  const option = parsed.values.entry
  // A directory is the project, as `build` and `check` take it; anything else is the server entry in the current one.
  const inDir = path !== undefined && statSync(path, { throwIfNoEntry: false })?.isDirectory() === true

  if (path !== undefined && !existsSync(path)) {
    console.error(`kay dev: ${path} is neither a directory nor a file`)

    return 1
  }

  if (path !== undefined && !inDir && typeof option === 'string') {
    console.error(`kay: ${path} is not a directory, and --entry names the server entry already\n${USAGE}`)

    return 1
  }

  const root = resolve(inDir ? path : '.')
  const entry = typeof option === 'string' ? resolve(option) : inDir ? undefined : path
  const { routes, publicDir, api, settings } = await loadConfig(root)
  const stop = await dev(root, { entry, routes, publicDir, api, settings })
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
      console.error(`${formatDiagnostic(source, relative(process.cwd(), file), diagnostic, toStderr)}\n`)
  }

  for (const file of changed)
    console.error(`${write ? 'formatted' : 'not formatted'}: ${relative(process.cwd(), file)}`)

  return errors.length > 0 || (!write && changed.length > 0) ? 1 : 0
}

process.exit(await main(process.argv.slice(2)))
