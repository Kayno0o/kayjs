import type { ImportGraph, KayLibrary } from './libraries'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { importEdges, reachedFrom } from './libraries'

// kayjs-ui draws its icons from a registry keyed by slot, `settings.icons[slot]`, which a bundler cannot shrink: an island would carry every icon of it. The build instead reads the slots the project and the modules it reaches write, and loads the registry holding those alone.
// A slot is named where the code writes it as a string, `icon="close"` or `icon: 'close'`; pages hand them to islands as props, so every `.kay` file of the build is read, not only what an island imports. One taken from a variable in the project's own code may be any slot, so the whole registry stays.
const WORD = /(["'`])(\w+)\1/g
const ICON_PROP = /\b\w*[iI]con\w*=\{((?:[^{}]|\{[^{}]*\})*)\}/g
const ICON_KEY = /\b\w*[iI]con\w*\s*:\s*([^,}\n]+)/g
const ICON_IMPORT = /^import\s+(\w+)\s+from\s+(["'])~icons\/[^"'\n]+\2/gm
const LITERAL = /^(["'])\w+\1$/
const CHOICE = /^[^'"`?]+\?\s*(["'])\w+\1\s*:\s*(["'])\w+\2$/
const IDENTIFIER = /^[\w$]+$/
const TYPE_WORD = /^(?:string|undefined|null|true|false|any|unknown|number|boolean)\b/
const LOWERCASE = /^[a-z]/
const SLOT_NAME = /^\w+/
const IN_PACKAGES = /[\\/]node_modules[\\/]/
const SCANNED = /\.(?:kay|[cm]?[jt]sx?)$/

// The registry modules of kayjs-ui, by where the project reaches it: in a checkout or under `node_modules`.
export const REGISTRY_FILE = /[\\/](?:packages[\\/]ui|node_modules[\\/]@kayjs[\\/]ui)[\\/]src[\\/](?:defaults|added-icons)\.ts$/

// Whether a registry module belongs to kayjs-ui itself, not to an app's own `packages/ui`.
export function isUiRegistry(file: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(dirname(file), '../package.json'), 'utf8')) as { name?: string }).name === '@kayjs/ui'
  }
  catch {
    return false
  }
}

// Whether the value written for an icon is a slot or an icon of a set, and not something computed.
function isStatic(value: string, imported: ReadonlySet<string>): boolean {
  const written = value.trim()

  return LITERAL.test(written) || CHOICE.test(written) || (IDENTIFIER.test(written) && imported.has(written))
}

// The words written as strings in the files of the build and what they import, or undefined when a slot may come from a variable.
export async function iconSlotsOf(root: string, entries: Iterable<string>, libraries: KayLibrary[], graph?: ImportGraph): Promise<ReadonlySet<string> | undefined> {
  const project = realpathSync(root) + sep
  const reached = await reachedFrom([...entries], importEdges(root, libraries, graph))
  const slots = new Set<string>()
  let dynamic = false

  await Promise.all([...reached].map(async (file) => {
    if (REGISTRY_FILE.test(file) || !SCANNED.test(file))
      return

    const text = await Bun.file(file).text()

    for (const [, , word] of text.matchAll(WORD))
      slots.add(word!)

    if (!file.startsWith(project) || IN_PACKAGES.test(file.slice(project.length)))
      return

    const imported = new Set([...text.matchAll(ICON_IMPORT)].map(hit => hit[1]!))

    for (const [, value] of text.matchAll(ICON_PROP)) {
      if (!isStatic(value!, imported))
        dynamic = true
    }

    for (const [, value] of text.matchAll(ICON_KEY)) {
      const written = value!.trim()

      // A type annotation, `icon: IconSlot`, writes no value.
      if (!isStatic(written, imported) && (written.includes('.') || written.includes('(') || written.includes('[') || (LOWERCASE.test(written) && !TYPE_WORD.test(written))))
        dynamic = true
    }
  }))

  return dynamic ? undefined : slots
}

const REGISTRY = /^(\s*icons: |export const addedIcons\b[^=\n]*= )\{ ([^{}\n]*) \}(,?)$/m
const ICON_IMPORT_LINE = /^import (\w+) from '~icons\/[^'\n]+'\n/gm

// A registry module with the entries of `slots` only, the imports of the others dropped with them. A module whose registry is not written on one line as `{ slot, other: local }` is left as it is.
export function registryWith(source: string, slots: ReadonlySet<string>): string {
  const hit = REGISTRY.exec(source)

  if (hit === null)
    return source

  const kept = hit[2]!.split(', ').filter(entry => slots.has(SLOT_NAME.exec(entry)![0]))
  const body = source.replace(REGISTRY, () => `${hit[1]}{ ${kept.join(', ')} }${hit[3]}`)
  const names = new Set(kept.map(entry => entry.split(':').at(-1)!.trim()))

  return body.replace(ICON_IMPORT_LINE, (line, name: string) => names.has(name) ? line : '')
}

// What a cache keyed on the slots holds of them.
export function slotsKey(slots: ReadonlySet<string> | undefined): string {
  return slots === undefined ? '*' : [...slots].sort().join(',')
}
