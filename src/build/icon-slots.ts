import type { ImportGraph, KayLibrary } from './libraries'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { importEdges, reachedFrom } from './libraries'

// kayjs-ui draws its icons from a registry keyed by slot, `settings.icons[slot]`, which a bundler cannot shrink: an island would carry every icon of it. The build instead reads the slots the modules an island reaches can name, and loads the registry holding those alone.
// A slot is named where the code writes it as a string, `icon="close"` or `icon: 'close'`. One taken from a variable, in the project's own code, may be any slot, so the whole registry stays.
const WORD = /(["'])(\w+)\1/g
const ICON_PROP = /\bicon=\{([^{}]*)\}/g
const ICON_IMPORT = /^import\s+(\w+)\s+from\s+(["'])~icons\/[^"'\n]+\2/gm
const IDENTIFIER = /^[\w$]+$/
const SLOT_NAME = /^\w+/
const IN_PACKAGES = /[\\/]node_modules[\\/]/

// The registry modules of kayjs-ui, by where the project reaches it: in a checkout or under `node_modules`.
export const REGISTRY_FILE = /[\\/](?:packages[\\/]ui|node_modules[\\/]@kayjs[\\/]ui)[\\/]src[\\/](?:defaults|added-icons)\.ts$/

// The words written as strings in the modules the islands reach, or undefined when a slot may come from a variable.
export async function iconSlotsOf(root: string, entries: Iterable<string>, libraries: KayLibrary[], graph?: ImportGraph): Promise<ReadonlySet<string> | undefined> {
  const project = realpathSync(root) + sep
  const reached = await reachedFrom([...entries], importEdges(root, libraries, graph))
  const slots = new Set<string>()
  let dynamic = false

  await Promise.all([...reached].map(async (file) => {
    if (REGISTRY_FILE.test(file) || !(file.endsWith('.kay') || file.endsWith('.ts') || file.endsWith('.tsx')))
      return

    const text = await Bun.file(file).text()

    for (const [, , word] of text.matchAll(WORD))
      slots.add(word!)

    if (!file.startsWith(project) || IN_PACKAGES.test(file.slice(project.length)))
      return

    const imported = new Set([...text.matchAll(ICON_IMPORT)].map(hit => hit[1]!))

    for (const [, expression] of text.matchAll(ICON_PROP)) {
      const written = expression!.trim()

      if (!written.includes('\'') && !written.includes('"') && !written.includes('`') && !(IDENTIFIER.test(written) && imported.has(written)))
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
  return slots === undefined ? '' : [...slots].sort().join(',')
}
