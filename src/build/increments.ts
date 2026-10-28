import type { ClassWords } from '../dev/tailwind'
import type { ClientManifest } from '../server/client'
import type { ClientOptions, ClientSources } from './client'
import type { ChunkInputs } from './report'
import type { StyleUses } from './style-uses'
import { realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tailwindClasses } from '../dev/tailwind'
import { clientDir, DEV_MAPS_DIR, outputDir } from './assets'
import { CSS_FILE, KAY_MODULE, readSource, writeAtomically } from './files'
import { fileWords, sourceWords } from './libraries'
import { classTokens, NAMING_FILE } from './prune'
import { referencesOf } from './references'
import { mapBundleToKay } from './sourcemap'
import { styleSignature } from './styles'

// What an incremental build keeps of the last one, to tell what an edit reaches.
export interface Built {
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
  // The class tables the islands were built with, the app-wide one and the one they ship, as JSON.
  classTable: string | undefined
  // The manifest as written: another one in its place, as a server building its own client writes, means building everything again.
  manifest: string
}

interface Signed {
  hash: number | bigint
  signature: string | undefined
}

const SCRIPT_OR_COMPONENT = /\.(?:kay|[cm]?[jt]sx?)$/
// The files Tailwind reads classes from.
const SCANNED_FILE = /\.(?:kay|[cm]?[jt]sx?|html|mdx?)$/

// What `kay dev`'s builder compares across its builds: what each module the stylesheets follow signed as, and the island maps pointed at `.kay` lines.
export class Increments {
  private readonly plugins: boolean
  // What a module's text signed as, so a stylesheet build parses only the inputs whose text changed since it last did.
  private readonly signed = new Map<string, Signed>()
  // What each chunk's map was pointed at `.kay` lines for, and the rewriting still going on after the build answered.
  private readonly mapKeys = new Map<string, string>()
  private mapWork: { stop: boolean, done: Promise<void> } | undefined

  constructor(private readonly root: string, private readonly options: ClientOptions) {
    this.plugins = (options.plugins?.length ?? 0) > 0
  }

  // A build of everything parses every stylesheet input again.
  forgetSignatures(): void {
    this.signed.clear()
  }

  // A rewrite still going stops after the map it is on, so it never writes over the maps of the build that is starting; `fresh` forgets the maps pointed, for a build of everything.
  async stopMaps(fresh: boolean): Promise<void> {
    if (this.mapWork) {
      this.mapWork.stop = true
      await this.mapWork.done
    }

    if (fresh)
      this.mapKeys.clear()
  }

  // The rewriting of the maps the last build that bundled islands started.
  get mapsPointed(): Promise<void> | undefined {
    return this.mapWork?.done
  }

  async stylesChanged(previous: Built, sources: ClientSources, texts: Map<string, string | undefined>): Promise<boolean> {
    if (!sameItems(previous.sources.pages, sources.pages) || (this.plugins && !sameItems(previous.sources.classes, sources.classes)))
      return true

    const named = (words: string[]) => words.some(word => classTokens(word).some(token => previous.unused.has(token)))

    if (previous.unused.size > 0 && named([...sources.classes].filter(word => !previous.sources.classes.has(word))))
      return true

    for (const [file, text] of texts) {
      if (CSS_FILE.test(file))
        return true

      if (previous.styleInputs.has(file) && (text === undefined || await this.signatureOf(file, text) !== previous.signatures.get(file)))
        return true

      if (previous.unused.size > 0 && text !== undefined && NAMING_FILE.test(file) && named([text]))
        return true

      const known = previous.words.get(file)

      if (this.plugins && text !== undefined && SCANNED_FILE.test(file)) {
        const fresh = known ? sourceWords(text).filter(word => !known.has(word)) : sourceWords(text)

        if (fresh.length > 0 && (await this.classesOf(previous))?.(fresh, text) !== false)
          return true
      }
    }

    return false
  }

  // What the next build compares against: `scripts` and `styles` are what this one bundled again, the rest is the last build's.
  next(previous: Built | undefined, built: Pick<Built, 'sources' | 'islandInputs' | 'styleInputs' | 'classTable' | 'manifest'>, scripts: { manifest: Built['islands'] } | undefined, styles: { styles: Record<string, string>, unused: Set<string>, uses?: StyleUses | undefined } | undefined, texts: Map<string, string | undefined>): Built {
    for (const file of this.signed.keys()) {
      if (!built.styleInputs.has(file))
        this.signed.delete(file)
    }

    const signatures = styles ? new Map<string, string>() : previous!.signatures
    const words = previous?.words ?? new Map<string, Set<string>>()

    for (const [file, text] of texts) {
      if (text === undefined || !this.plugins || !SCANNED_FILE.test(file))
        words.delete(file)
      else
        words.set(file, new Set(sourceWords(text)))
    }

    return {
      ...built,
      islands: scripts?.manifest ?? previous!.islands,
      styles: styles?.styles ?? previous!.styles,
      signatures,
      words,
      unused: styles?.unused ?? previous!.unused,
      styleUses: styles ? styles.uses : previous!.styleUses,
      read: styles ? this.readInputs(built.styleInputs, signatures, words) : Promise.resolve(),
      classes: styles ? undefined : previous!.classes,
    }
  }

  // A chunk with the name and `.kay` sources of the last build keeps its map as that one was pointed at `.kay` lines, put back from `DEV_MAPS_DIR` at once; the others are pointed in the background, as a browser only reads a map once its devtools open, and the server then sends them as they are.
  async pointMaps(scripts: { maps: string[], inputs: ChunkInputs }): Promise<void> {
    const { root } = this
    const base = clientDir(root)
    const saved = join(outputDir(root), DEV_MAPS_DIR)
    const work = { stop: false, done: Promise.resolve() }
    const pending: { map: string, name: string, key: string }[] = []
    const names = new Set<string>()
    const keys = this.mapKeys

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

    this.mapWork = work
  }

  private async classesOf(built: Built): Promise<ClassWords | undefined> {
    return built.classes ??= tailwindClasses(this.root, built.styleInputs, referencesOf(this.options.extensions))
  }

  private async readInputs(inputs: Set<string>, signatures: Map<string, string>, words: Map<string, Set<string>>): Promise<void> {
    await Promise.all([...inputs].map(async (file) => {
      const text = readSourceText(file)

      if (text === undefined)
        return

      // One that does not parse has no signature, so its next edit builds the stylesheets again.
      if (SCRIPT_OR_COMPONENT.test(file)) {
        const signature = await this.signatureOf(file, text)

        if (signature !== undefined)
          signatures.set(file, signature)
      }

      if (this.plugins && SCANNED_FILE.test(file))
        words.set(file, new Set(fileWords(file)))
    }))
  }

  private async signatureOf(file: string, text: string): Promise<string | undefined> {
    const hash = Bun.hash(text)
    const known = this.signed.get(file)

    if (known?.hash === hash)
      return known.signature

    let signature: string | undefined

    try {
      signature = await styleSignature(file, text)
    }
    catch {}

    this.signed.set(file, { hash, signature })

    return signature
  }
}

// What a chunk's map depends on besides the chunk's name, which holds its code's hash: the text of each `.kay` file in it. Undefined for a chunk with none, whose map has nothing to point.
function kayKey(root: string, inputs: ChunkInputs[string] | undefined): string | undefined {
  const files = Object.keys(inputs ?? {}).filter(input => KAY_MODULE.test(input)).sort()

  if (files.length === 0)
    return undefined

  return Bun.hash(files.map(file => `${file}\0${readSourceText(resolve(root, file.replace(KAY_MODULE, '.kay'))) ?? ''}`).join('\0')).toString(36)
}

function readSourceText(file: string): string | undefined {
  try {
    return readSource(file).text
  }
  catch {
    return undefined
  }
}

// By real path, as the bundler names its inputs.
export function realPaths(files: string[]): Set<string> {
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

export function sameEntries(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([id, file]) => b.get(id) === file)
}
