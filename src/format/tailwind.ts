import type { ClassSorter } from '../compiler/format'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { CSS_FILE, findProjectFiles } from '../build/files'
import { configReferences, withReferences } from '../build/references'
import { stylesheetPath, TAILWIND_IMPORT } from '../dev/tailwind'

export interface Design {
  getClassOrder: (classes: string[]) => [string, bigint | null][]
  // The CSS each class compiles to, or null for one Tailwind does not know.
  candidatesToCss: (classes: string[]) => (string | null)[]
  // How Tailwind reads a class, empty for a word that names no utility.
  parseCandidate?: (candidate: string) => readonly unknown[]
}

type LoadDesign = (css: string, options: object) => Promise<Design>

// Where the entry stylesheet usually is, tried before the others.
const ENTRY = 'src/app.css'
// The imports of Tailwind's parts, which an app writing its layers by hand uses in place of the whole.
const PARTS_IMPORT = /@import\s+(?:url\(\s*)?['"]tailwindcss\/(?:theme|utilities)\.css['"]/
const PACKAGE_NAME = /^(?:@[^/]+\/)?[^/]+/

// A design system and every stylesheet it read with the stamp of each, so an edit to any of them loads it again.
interface Loaded {
  sorter: ClassSorter | undefined
  design: Design | undefined
  // Why the design system did not load.
  failure?: string | undefined
  files: Map<string, string>
}

const loads = new Map<string, { entry: string, loaded: Promise<Loaded> }>()

// Tailwind's own order for a class list, from the design system of the app's `tailwindcss` and its entry stylesheet, as `eslint-plugin-better-tailwindcss` orders a class string: unknown classes first as written, then by Tailwind's index.
// Undefined when the app does not use Tailwind or its design system does not load, which leaves the classes as written; a design system that did not load is tried again on the next call.
export async function tailwindSorter(root: string): Promise<ClassSorter | undefined> {
  return (await tailwindLoad(root, false, await configReferences(root)))?.sorter
}

// The design system of the app's Tailwind, loaded as the sorter's is and kept while no stylesheet it read changes; undefined when the app does not use Tailwind, and a `failure` instead of the design when it does not load.
export async function tailwindDesign(root: string, references: string[]): Promise<{ design?: Design | undefined, failure?: string | undefined } | undefined> {
  return tailwindLoad(root, true, references)
}

async function tailwindLoad(root: string, parts: boolean, references: string[]): Promise<Loaded | undefined> {
  const entry = await tailwindEntry(root, parts)
  const key = `${root}\0${parts}\0${references.join('\0')}`

  if (entry === undefined)
    return undefined

  const known = loads.get(key)

  if (known?.entry === entry) {
    const loaded = await known.loaded

    if (loaded.sorter && [...loaded.files].every(([file, stamp]) => stampOf(file) === stamp))
      return loaded
  }

  const loaded = loadDesign(entry, root, references)

  loads.set(key, { entry, loaded })

  return loaded
}

const tailwindApps = new Map<string, Promise<boolean>>()

// Whether the app imports Tailwind in a stylesheet, read once per project and process: adding it needs a restart of `kay dev`.
export async function usesTailwind(root: string): Promise<boolean> {
  let known = tailwindApps.get(root)

  if (known === undefined)
    tailwindApps.set(root, known = hasTailwindEntry(root))

  return known
}

async function hasTailwindEntry(root: string): Promise<boolean> {
  return await tailwindEntry(root, true) !== undefined
}

export async function tailwindEntry(root: string, parts: boolean): Promise<string | undefined> {
  const preferred = join(root, ENTRY)

  if (await importsTailwind(preferred, parts))
    return preferred

  for (const file of (await findProjectFiles(root, CSS_FILE, { project: true, ownKayOnly: true })).toSorted()) {
    if (await importsTailwind(file, parts))
      return file
  }

  return undefined
}

async function importsTailwind(file: string, parts: boolean): Promise<boolean> {
  try {
    const text = await Bun.file(file).text()

    return TAILWIND_IMPORT.test(text) || (parts && PARTS_IMPORT.test(text))
  }
  catch {
    return false
  }
}

// Bun resolves a package missing from a tree with no node_modules by installing it from npm, and a formatter reaches no network: no sorting before the app is installed.
export function installed(name: string, from: string): boolean {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name)))
      return true

    if (dirname(dir) === dir)
      return false
  }
}

// A stylesheet or module the design system asks for, which is a package only when it is installed.
function assertResolvable(id: string, from: string): void {
  if (id.startsWith('.') || isAbsolute(id))
    return

  const name = PACKAGE_NAME.exec(id)?.[0] ?? id

  if (!installed(name, from))
    throw new Error(`${name} is not installed`)
}

// The size beside the time, as two writes in one millisecond share a time.
function stampOf(path: string): string {
  const file = Bun.file(path)

  return `${file.lastModified}:${file.size}`
}

async function loadDesign(entry: string, root: string, references: string[]): Promise<Loaded> {
  const files = new Map([[entry, stampOf(entry)]])
  const { design, failure } = await loadDesignSystem(entry, files, root, references)

  return { sorter: design && (classes => design.getClassOrder(classes).toSorted(([, a], [, b]) => compareIndex(a, b)).map(([name]) => name)), design, failure, files }
}

// Runs the project's own Tailwind plugin and config modules, as its build does, so the order holds for the utilities they add; none that is not installed.
async function loadDesignSystem(entry: string, files: Map<string, string>, root: string, references: string[]): Promise<{ design?: Design, failure?: string }> {
  try {
    const base = dirname(entry)

    if (!installed('tailwindcss', base))
      return { failure: 'tailwindcss is not installed' }

    const tailwind = await import(Bun.resolveSync('tailwindcss', base)) as { __unstable__loadDesignSystem?: LoadDesign }
    const design = await tailwind.__unstable__loadDesignSystem?.(withReferences(await Bun.file(entry).text(), entry, root, references), {
      base,
      loadStylesheet: async (id: string, from: string) => {
        assertResolvable(id, from)

        const path = await stylesheetPath(id, from)

        files.set(path, stampOf(path))

        return { path, base: dirname(path), content: await Bun.file(path).text() }
      },
      loadModule: async (id: string, from: string) => {
        assertResolvable(id, from)

        const path = id.startsWith('.') ? resolve(from, id) : Bun.resolveSync(id, from)

        return { path, base: dirname(path), module: (await import(path) as { default: unknown }).default }
      },
    })

    return design === undefined ? { failure: 'this version of tailwindcss has no design system to load' } : { design }
  }
  catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) }
  }
}

function compareIndex(a: bigint | null, b: bigint | null): number {
  if (a === b)
    return 0

  if (a === null)
    return -1

  return b === null ? 1 : Number(a > b) - Number(a < b)
}
