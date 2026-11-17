import type { ImportedComponent, ImportedComponents } from '../compiler/lazy-imports'
import type { ImportBinding } from '../compiler/script-shared'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { deferredProps, eagerReach, lazyImports } from '../compiler/lazy-imports'
import { parseKay } from '../compiler/parser'
import { resolveFrom } from './files'
import { fences } from './libraries'

// A default import of a `.kay` module, as a script writes it on a line of its own.
const KAY_IMPORT = /^[ \t]*import\s+([\w$]+)\s+from\s*(['"])([^'"]+\.kay)\2/gm

interface Facts {
  // The own stamp of the module and of each module its answer reads: the facts are read again once any changes.
  stamps: Map<string, string>
  deferred: string[]
  size: number
  // The paths of the components the module loads with it, which a module importing it does not need a chunk for.
  reach: string[]
}

// What a key may not hold, as the page writes keys apart by a space inside an attribute.
const UNSAFE_KEY = /[^\w.-]/g

const known = new Map<string, Facts>()

function stampOf(path: string): string | undefined {
  const stats = statSync(path, { throwIfNoEntry: false })

  return stats ? `${stats.mtimeMs}-${stats.size}` : undefined
}

function importsOf(source: string): ImportBinding[] {
  return [...fences(source).matchAll(KAY_IMPORT)].map(([line, local, , specifier]) => ({ local: local!, imported: 'default', source: specifier!, typeOnly: false, span: { start: 0, end: 0 }, declaration: { start: source.indexOf(line), end: source.indexOf(line) + line.trimEnd().length } }))
}

// The props a component draws only where a branch may not render, which hold when each module it passes a block to says the same of that block: a wrapper of a dialog defers what the dialog does.
function factsOf(path: string, visiting: ReadonlySet<string>): Facts | undefined {
  const stamp = stampOf(path)

  if (stamp === undefined || visiting.has(path))
    return undefined

  const kept = known.get(path)

  if (kept && [...kept.stamps].every(([module, expected]) => stampOf(module) === expected))
    return kept

  const source = readFileSync(path, 'utf8')
  const stamps = new Map([[path, stamp]])
  const inside = new Set([...visiting, path])
  const file = parseKay(source)
  const imports = importsOf(source)
  const children: Record<string, ImportedComponent> = {}

  for (const { source: specifier } of imports) {
    const found = resolveFrom(specifier, path)
    const facts = found === undefined ? undefined : factsOf(found, inside)

    for (const [module, other] of facts?.stamps ?? [])
      stamps.set(module, other)

    if (found !== undefined && facts !== undefined)
      children[specifier] = { key: found, deferred: facts.deferred, size: facts.size, reach: facts.reach }
  }

  const deferred = deferredProps(file, imports, specifier => children[specifier])
  const reach = eagerReach(imports, children, lazyImports(file, imports, children))
  const facts = { stamps, deferred, size: source.length, reach }

  known.set(path, facts)

  return facts
}

// What names a lazy component's chunk to the page that draws it and to the build's manifest: the file's name and a hash of its path from the root, the same wherever it is read from.
export function lazyKey(root: string, path: string): string {
  const name = basename(path, '.kay').replaceAll(UNSAFE_KEY, '_')

  return `${name}-${Bun.hash(relative(realOf(root), realOf(path)).replaceAll('\\', '/')).toString(36).slice(0, 6)}`
}

// The components whose lazy chunk the build found to be a stub, which then load with the code drawing them.
const eager = new Set<string>()

// Marks components as loading with their importers; whether any was not marked already.
export function keepEager(keys: Iterable<string>): boolean {
  const before = eager.size

  for (const key of keys)
    eager.add(key)

  return eager.size > before
}

// The keys marked so far, which a cache of what depends on the imports the islands make has to key on.
export function eagerKeys(): string[] {
  return [...eager].sort()
}

// Its path with the links resolved, or as it is when no file is there.
function realOf(path: string): string {
  try {
    return realpathSync(path)
  }
  catch {
    return path
  }
}

// The `.kay` components a file imports that its templates may draw lazily: each with the key naming its chunk (its path from the root) and the props it draws only inside a branch that may not render.
export function importedComponents(file: string, source: string, root: string): ImportedComponents {
  const found: Record<string, ImportedComponent> = {}
  const self = realOf(file)

  for (const { source: specifier } of importsOf(source)) {
    const path = resolveFrom(specifier, file)

    // A component drawing itself stays eager whatever its import is written as: its module is the one loading, so a chunk would only make its nested draws late.
    if (path !== undefined && realOf(path) === self)
      continue

    const facts = path === undefined ? undefined : factsOf(path, new Set())

    if (path !== undefined && facts !== undefined)
      found[specifier] = { key: lazyKey(root, path), deferred: facts.deferred, size: eager.has(lazyKey(root, path)) ? 0 : facts.size, reach: facts.reach.map(other => lazyKey(root, other)) }
  }

  return found
}
