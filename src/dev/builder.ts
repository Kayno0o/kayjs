import type { ClientOptions, ClientSources } from '../build/client'
import type { ImportGraph } from '../build/libraries'
import type { ChunkInputs } from '../build/report'
import type { StyleUses } from '../build/style-uses'
import type { ClientManifest } from '../server/client'
import type { ClassWords } from './tailwind'
import { realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { clientDir, DEV_MAPS_DIR, outputDir } from '../build/assets'
import { bothBundles, bundleIslands, bundleStyles, clearClientOutput, readClientSources, writeClasses } from '../build/client'
import { CSS_FILE, forgetSources, inWalkScope, keepSources, readSource, writeAtomically } from '../build/files'
import { fileWords, sourceWords } from '../build/libraries'
import { classTokens, NAMING_FILE } from '../build/prune'
import { inSignalsScope } from '../build/signals'
import { mapBundleToKay } from '../build/sourcemap'
import { styleSignature } from '../build/styles'
import { KayCompileError } from '../build/transform'
import { withConfig } from '../config'
import { clientOptionsOf } from '../project'
import { BUILD_FAILURE, clientOptionsKey, MANIFEST } from '../server/client'
import { tailwindClasses } from './tailwind'

// `kay dev` asks for a build with the files changed since the last one, relative to the root, or null for a build of everything.
export interface BuildRequest {
  build: string[] | null
}

// The stylesheets by page when they were built again, for a running server to swap in.
export interface BuildOutcome {
  failed: boolean
  styles?: Record<string, string> | undefined
}

// What a failed build leaves for the server to serve as its boot failure: the message of what threw, and the compile errors when it was them.
export interface BuildFailure {
  options: string
  message: string
  diagnostics?: KayCompileError['diagnostics']
}

interface Built {
  sources: ClientSources
  islands: Omit<ClientManifest, 'styles'>
  islandInputs: Set<string>
  styles: Record<string, string>
  styleInputs: Set<string>
  // What the stylesheet build reads of each module it followed, and the words of each file Tailwind may read classes from.
  signatures: Map<string, string>
  words: Map<string, Set<string>>
  // Which new words make Tailwind classes, when a stylesheet imports it: compiled by the first new word after each stylesheet build, so edits adding none pay nothing.
  classes?: Promise<ClassWords | undefined> | undefined
  // The classes of a kay library's stylesheets whose rules the stylesheets left out, as nothing named them.
  unused: Set<string>
  // Which classes each page and layout names, for the dev page to check what it sets against.
  styleUses?: StyleUses | undefined
  // Reading them once the stylesheets are built, which the next build waits for.
  read: Promise<void>
  // The manifest as written: another one in its place, as a server building its own client writes, means building everything again.
  manifest: string
}

// A `.kay` module of a chunk, a static component's `?island` twin included.
const KAY_INPUT = /\.kay(?:\?island)?$/
const SCRIPT_OR_COMPONENT = /\.(?:kay|[cm]?[jt]sx?)$/
// The files Tailwind reads classes from.
const SCANNED_FILE = /\.(?:kay|[cm]?[jt]sx?|html|mdx?)$/

// Builds the client for the servers `kay dev` starts, under `.kay/dev`, as `kay build` does for production: a server reads the manifest, or what failed, instead of bundling as it boots.
// An edit builds again only what it reaches: the islands when it touched a module of theirs or the set of islands, the stylesheets when it touched a stylesheet, the pages, what a module the stylesheets follow imports, or, with a plugin such as Tailwind, the classes. A failed build makes the next one build everything.
export function devBuilder(root: string, options: ClientOptions): (changed: string[] | null) => Promise<BuildOutcome> {
  const key = clientOptionsKey(options)
  const plugins = (options.plugins?.length ?? 0) > 0
  const output = outputDir(root)
  const realRoot = realpathSync(root)
  let last: Built | undefined
  const graph: ImportGraph = new Map()
  // What a module's text signed as, so a stylesheet build parses only the inputs whose text changed since it last did.
  const signed = new Map<string, { hash: number | bigint, signature: string | undefined }>()
  // What each chunk's map was pointed at `.kay` lines for, and the rewriting still going on after the build answered.
  const mapKeys = new Map<string, string>()
  let mapWork: { stop: boolean, done: Promise<void> } | undefined
  const classesOf = async (built: Built) => built.classes ??= tailwindClasses(built.styleInputs)

  const stylesChanged = async (previous: Built, sources: ClientSources, texts: Map<string, string | undefined>): Promise<boolean> => {
    if (!sameItems(previous.sources.pages, sources.pages) || (plugins && !sameItems(previous.sources.classes, sources.classes)))
      return true

    const named = (words: string[]) => words.some(word => classTokens(word).some(token => previous.unused.has(token)))

    if (previous.unused.size > 0 && named([...sources.classes].filter(word => !previous.sources.classes.has(word))))
      return true

    for (const [file, text] of texts) {
      if (CSS_FILE.test(file))
        return true

      if (previous.styleInputs.has(file) && (text === undefined || await signatureOf(file, text, signed) !== previous.signatures.get(file)))
        return true

      if (previous.unused.size > 0 && text !== undefined && NAMING_FILE.test(file) && named([text]))
        return true

      const known = previous.words.get(file)

      if (plugins && text !== undefined && SCANNED_FILE.test(file)) {
        const fresh = known ? sourceWords(text).filter(word => !known.has(word)) : sourceWords(text)

        if (fresh.length > 0 && (await classesOf(previous))?.(fresh, text) !== false)
          return true
      }
    }

    return false
  }

  const readInputs = async (inputs: Set<string>, signatures: Map<string, string>, words: Map<string, Set<string>>) => {
    await Promise.all([...inputs].map(async (file) => {
      const text = readSourceText(file)

      if (text === undefined)
        return

      // One that does not parse has no signature, so its next edit builds the stylesheets again.
      if (SCRIPT_OR_COMPONENT.test(file)) {
        const signature = await signatureOf(file, text, signed)

        if (signature !== undefined)
          signatures.set(file, signature)
      }

      if (plugins && SCANNED_FILE.test(file))
        words.set(file, new Set(fileWords(file)))
    }))
  }

  const build = async (changed: string[] | null): Promise<BuildOutcome> => {
    // A full build reads every module's imports afresh.
    if (changed === null) {
      graph.clear()
      signed.clear()
      forgetSources()
    }

    const sources = await readClientSources(root, options, graph)

    keepSources()
    const previous = changed !== null && last !== undefined && await readText(join(output, MANIFEST)) === last.manifest ? last : undefined

    last = undefined
    await previous?.read

    // By real path, as the bundler names its inputs.
    const files = (changed ?? []).map(file => join(realRoot, file))
    const texts = new Map(await Promise.all(files.map(async file => [file, await readText(file)] as const)))
    const islandsAgain = !previous || !sameEntries(previous.sources.islands, sources.islands) || files.some(file => previous.islandInputs.has(file))
    const stylesAgain = !previous || await stylesChanged(previous, sources, texts)

    // A rewrite still going stops after the map it is on, so it never writes over the maps of the build that is starting.
    if (islandsAgain && mapWork) {
      mapWork.stop = true
      await mapWork.done
    }

    if (!previous)
      mapKeys.clear()

    if (previous)
      await rm(join(output, BUILD_FAILURE), { force: true })
    else
      await Promise.all([clearClientOutput(root), rm(join(output, BUILD_FAILURE), { force: true })])

    await writeClasses(root, sources.classes)

    const [scripts, styles] = await bothBundles(islandsAgain ? bundleIslands(root, sources.islands, options) : undefined, stylesAgain ? bundleStyles(root, sources, options) : undefined)
    const manifest: ClientManifest = { ...scripts?.manifest ?? previous!.islands, styles: styles?.styles ?? previous!.styles, ...(styles ? styles.uses : previous!.styleUses) && { styleUses: (styles ? styles.uses : previous!.styleUses)! }, problems: sources.problems, options: key }
    const text = JSON.stringify(manifest)

    await Bun.write(join(output, MANIFEST), text)

    if (scripts)
      mapWork = await pointMapsAtKay(root, scripts, mapKeys)

    const styleInputs = styles ? realPaths([...styles.inputs, ...styles.followed]) : previous!.styleInputs

    for (const file of signed.keys()) {
      if (!styleInputs.has(file))
        signed.delete(file)
    }

    const signatures = styles ? new Map<string, string>() : previous!.signatures
    const words = previous?.words ?? new Map<string, Set<string>>()

    for (const [file, text] of texts) {
      if (text === undefined || !plugins || !SCANNED_FILE.test(file))
        words.delete(file)
      else
        words.set(file, new Set(sourceWords(text)))
    }

    last = {
      sources,
      islands: scripts?.manifest ?? previous!.islands,
      islandInputs: scripts ? realPaths(Object.values(scripts.inputs).flatMap(inputs => Object.keys(inputs))) : previous!.islandInputs,
      styles: manifest.styles,
      styleInputs,
      signatures,
      words,
      unused: styles?.unused ?? previous!.unused,
      styleUses: styles ? styles.uses : previous!.styleUses,
      read: styles ? readInputs(styleInputs, signatures, words) : Promise.resolve(),
      classes: styles ? undefined : previous!.classes,
      manifest: text,
    }

    return { failed: false, styles: styles?.styles }
  }

  return async (changed) => {
    try {
      return await inWalkScope(async () => inSignalsScope(async () => build(changed)))
    }
    catch (error) {
      last = undefined
      await Bun.write(join(output, BUILD_FAILURE), JSON.stringify(failureOf(error, key)))

      return { failed: true }
    }
  }
}

function failureOf(error: unknown, options: string): BuildFailure {
  if (error instanceof KayCompileError)
    return { options, message: error.message, diagnostics: error.diagnostics }

  // The bundler's errors come as the logs of an AggregateError, which its stack leaves out.
  const logs = error instanceof AggregateError ? error.errors.map(describeLog) : []

  return { options, message: [error instanceof Error ? error.stack ?? error.message : String(error), ...logs].join('\n') }
}

function describeLog(log: unknown): string {
  if (typeof log !== 'object' || log === null || !('message' in log))
    return String(log)

  const { position } = log as { position?: { file: string, line: number, column: number } | null }

  return position ? `${position.file}:${position.line}:${position.column}: ${String(log.message)}` : String(log.message)
}

// A chunk with the name and `.kay` sources of the last build keeps its map as that one was pointed at `.kay` lines, put back from `DEV_MAPS_DIR` at once; the others are pointed in the background, as a browser only reads a map once its devtools open, and the server then sends them as they are.
async function pointMapsAtKay(root: string, scripts: { maps: string[], inputs: ChunkInputs }, keys: Map<string, string>): Promise<{ stop: boolean, done: Promise<void> }> {
  const base = clientDir(root)
  const saved = join(outputDir(root), DEV_MAPS_DIR)
  const work = { stop: false, done: Promise.resolve() }
  const pending: { map: string, name: string, key: string }[] = []
  const names = new Set<string>()

  await Promise.all(scripts.maps.map(async (map) => {
    const name = relative(base, map)
    const key = kayKey(root, scripts.inputs[name.slice(0, -'.map'.length)])

    if (key === undefined)
      return

    names.add(name)

    if (keys.get(name) === key) {
      try {
        await writeAtomically(map, Bun.file(join(saved, name)))

        return
      }
      catch {
        keys.delete(name)
      }
    }

    pending.push({ map, name, key })
  }))

  for (const name of keys.keys()) {
    if (!names.has(name)) {
      keys.delete(name)
      void rm(join(saved, name), { force: true })
    }
  }

  work.done = (async () => {
    for (const { map, name, key } of pending) {
      if (work.stop)
        return

      try {
        await mapBundleToKay(map)
        await mkdir(dirname(join(saved, name)), { recursive: true })
        await writeAtomically(join(saved, name), Bun.file(map))
        keys.set(name, key)
      }
      catch {}
    }
  })()

  return work
}

// What a chunk's map depends on besides the chunk's name, which holds its code's hash: the text of each `.kay` file in it. Undefined for a chunk with none, whose map has nothing to point.
function kayKey(root: string, inputs: ChunkInputs[string] | undefined): string | undefined {
  const files = Object.keys(inputs ?? {}).filter(input => KAY_INPUT.test(input)).sort()

  if (files.length === 0)
    return undefined

  return Bun.hash(files.map(file => `${file}\0${readSourceText(resolve(root, file.replace(KAY_INPUT, '.kay'))) ?? ''}`).join('\0')).toString(36)
}

async function signatureOf(file: string, text: string, signed: Map<string, { hash: number | bigint, signature: string | undefined }>): Promise<string | undefined> {
  const hash = Bun.hash(text)
  const known = signed.get(file)

  if (known?.hash === hash)
    return known.signature

  let signature: string | undefined

  try {
    signature = await styleSignature(file, text)
  }
  catch {}

  signed.set(file, { hash, signature })

  return signature
}

function readSourceText(file: string): string | undefined {
  try {
    return readSource(file).text
  }
  catch {
    return undefined
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await Bun.file(file).text()
  }
  catch {
    return undefined
  }
}

function realPaths(files: string[]): Set<string> {
  return new Set(files.map((file) => {
    const path = resolve(file)

    try {
      return realpathSync(path)
    }
    catch {
      return path
    }
  }))
}

function sameItems(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = new Set(a)
  const right = new Set(b)

  return left.size === right.size && [...left].every(item => right.has(item))
}

function sameEntries(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([id, file]) => b.get(id) === file)
}

// Started by `kay dev` with the root as its working directory and an IPC channel: it reports the project's modules the config loaded, which a change to starts it again, then answers each request in turn.
if (import.meta.main) {
  const root = process.cwd()
  const config = await withConfig(root, {})
  const build = devBuilder(root, clientOptionsOf(config, { dev: true, underKayDev: true }))
  const project = realpathSync(root) + sep
  let queue = Promise.resolve()

  process.send!({ reads: Object.keys(require.cache).filter(path => path.startsWith(project) && !path.includes(`${sep}node_modules${sep}`)) })
  process.on('message', (message: BuildRequest) => {
    const previous = queue

    queue = (async () => {
      await previous
      process.send!({ built: await build(message.build) })
    })()
  })
  // `kay dev` is gone.
  process.on('disconnect', () => process.exit(0))
}
