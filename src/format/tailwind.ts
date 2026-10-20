import type { ClassSorter } from '../compiler/format'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CSS_FILE, findProjectFiles } from '../build/files'
import { stylesheetPath, TAILWIND_IMPORT } from '../dev/tailwind'

interface Design {
  getClassOrder: (classes: string[]) => [string, bigint | null][]
}

type LoadDesign = (css: string, options: object) => Promise<Design>

// Where the entry stylesheet usually is, tried before the others.
const ENTRY = 'src/app.css'
const sorters = new Map<string, { stamp: number, sorter: Promise<ClassSorter | undefined> }>()

// Tailwind's own order for a class list, from the design system of the app's `tailwindcss` and its entry stylesheet, as `eslint-plugin-better-tailwindcss` orders a class string: unknown classes first as written, then by Tailwind's index.
// Undefined when the app does not use Tailwind or its design system does not load, which leaves the classes as written.
export async function tailwindSorter(root: string): Promise<ClassSorter | undefined> {
  const entry = await tailwindEntry(root)

  if (entry === undefined)
    return undefined

  const stamp = Bun.file(entry).lastModified
  const known = sorters.get(root)

  if (known?.stamp === stamp)
    return known.sorter

  const sorter = designSorter(entry)

  sorters.set(root, { stamp, sorter })

  return sorter
}

async function tailwindEntry(root: string): Promise<string | undefined> {
  const preferred = join(root, ENTRY)

  if (await importsTailwind(preferred))
    return preferred

  for (const file of (await findProjectFiles(root, CSS_FILE, { project: true, ownKayOnly: true })).toSorted()) {
    if (await importsTailwind(file))
      return file
  }

  return undefined
}

async function importsTailwind(file: string): Promise<boolean> {
  try {
    return TAILWIND_IMPORT.test(await Bun.file(file).text())
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

async function designSorter(entry: string): Promise<ClassSorter | undefined> {
  try {
    const base = dirname(entry)

    if (!installed('tailwindcss', base))
      return undefined

    const tailwind = await import(Bun.resolveSync('tailwindcss', base)) as { __unstable__loadDesignSystem?: LoadDesign }
    const design = await tailwind.__unstable__loadDesignSystem?.(await Bun.file(entry).text(), {
      base,
      loadStylesheet: async (id: string, from: string) => {
        const path = await stylesheetPath(id, from)

        return { path, base: dirname(path), content: await Bun.file(path).text() }
      },
      loadModule: async (id: string, from: string) => {
        const path = id.startsWith('.') ? resolve(from, id) : Bun.resolveSync(id, from)

        return { path, base: dirname(path), module: (await import(path) as { default: unknown }).default }
      },
    })

    if (design === undefined)
      return undefined

    return classes => design.getClassOrder(classes).toSorted(([, a], [, b]) => compareIndex(a, b)).map(([name]) => name)
  }
  catch {
    return undefined
  }
}

function compareIndex(a: bigint | null, b: bigint | null): number {
  if (a === b)
    return 0

  if (a === null)
    return -1

  return b === null ? 1 : Number(a > b) - Number(a < b)
}
