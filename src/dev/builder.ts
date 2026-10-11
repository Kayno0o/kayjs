import type { ClientOptions, ClientSources } from '../build/client'
import type { ClientManifest } from '../server/client'
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import process from 'node:process'
import { outputDir } from '../build/assets'
import { bothBundles, bundleIslands, bundleStyles, clearClientOutput, readClientSources, writeClasses } from '../build/client'
import { sourceWords } from '../build/libraries'
import { mapBundleToKay } from '../build/sourcemap'
import { styleSignature } from '../build/styles'
import { KayCompileError } from '../build/transform'
import { withConfig } from '../config'
import { clientOptionsOf } from '../project'
import { BUILD_FAILURE, clientOptionsKey, MANIFEST } from '../server/client'

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
  // Reading them once the stylesheets are built, which the next build waits for.
  read: Promise<void>
  // The manifest as written: another one in its place, as a server building its own client writes, means building everything again.
  manifest: string
}

const CSS_FILE = /\.css$/
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

  const stylesChanged = async (previous: Built, sources: ClientSources, texts: Map<string, string | undefined>): Promise<boolean> => {
    if (!sameItems(previous.sources.pages, sources.pages) || (plugins && !sameItems(previous.sources.classes, sources.classes)))
      return true

    for (const [file, text] of texts) {
      if (CSS_FILE.test(file))
        return true

      if (previous.styleInputs.has(file) && (text === undefined || await signatureOf(file, text) !== previous.signatures.get(file)))
        return true

      const known = previous.words.get(file)

      if (plugins && text !== undefined && SCANNED_FILE.test(file) && (!known || sourceWords(text).some(word => !known.has(word))))
        return true
    }

    return false
  }

  const readInputs = async (inputs: Set<string>, signatures: Map<string, string>, words: Map<string, Set<string>>) => {
    await Promise.all([...inputs].map(async (file) => {
      const text = await readText(file)

      if (text === undefined)
        return

      // One that does not parse has no signature, so its next edit builds the stylesheets again.
      if (SCRIPT_OR_COMPONENT.test(file)) {
        try {
          signatures.set(file, await styleSignature(file, text))
        }
        catch {}
      }

      if (plugins && SCANNED_FILE.test(file))
        words.set(file, new Set(sourceWords(text)))
    }))
  }

  const build = async (changed: string[] | null): Promise<BuildOutcome> => {
    const sources = await readClientSources(root, options)
    const previous = changed !== null && last !== undefined && await readText(join(output, MANIFEST)) === last.manifest ? last : undefined

    last = undefined
    await previous?.read

    // By real path, as the bundler names its inputs.
    const files = (changed ?? []).map(file => join(realRoot, file))
    const texts = new Map(await Promise.all(files.map(async file => [file, await readText(file)] as const)))
    const islandsAgain = !previous || !sameEntries(previous.sources.islands, sources.islands) || files.some(file => previous.islandInputs.has(file))
    const stylesAgain = !previous || await stylesChanged(previous, sources, texts)

    if (previous)
      await rm(join(output, BUILD_FAILURE), { force: true })
    else
      await Promise.all([clearClientOutput(root), rm(join(output, BUILD_FAILURE), { force: true })])

    await writeClasses(root, sources.classes)

    const [scripts, styles] = await bothBundles(islandsAgain ? bundleIslands(root, sources.islands, options) : Promise.resolve(undefined), stylesAgain ? bundleStyles(root, sources, options) : Promise.resolve(undefined))
    const manifest: ClientManifest = { ...scripts?.manifest ?? previous!.islands, styles: styles?.styles ?? previous!.styles, problems: sources.problems, options: key }
    const text = JSON.stringify(manifest)

    await Bun.write(join(output, MANIFEST), text)

    if (scripts)
      void pointMapsAtKay(scripts.maps)

    const styleInputs = styles ? realPaths(styles.inputs) : previous!.styleInputs
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
      read: styles ? readInputs(styleInputs, signatures, words) : Promise.resolve(),
      manifest: text,
    }

    return { failed: false, styles: styles?.styles }
  }

  return async (changed) => {
    try {
      return await build(changed)
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

// In the background, as a browser only reads a map once its devtools open; the server then sends it as it is.
async function pointMapsAtKay(maps: string[]): Promise<void> {
  for (const map of maps) {
    try {
      await mapBundleToKay(map)
    }
    catch {}
  }
}

async function signatureOf(file: string, text: string): Promise<string | undefined> {
  try {
    return await styleSignature(file, text)
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
