import type { ImportedSignals, SignalKind } from '../compiler/module-signals'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync, statSync } from 'node:fs'
import { importedModules, moduleSignals, scanModule } from '../compiler/module-signals'
import { parseKay } from '../compiler/parser'
import { resolveFrom, SCRIPT_FILE, scriptLoader, transpilerFor } from './files'
import { fences } from './libraries'

const KAY_FILE = /\.kay$/
const KAY_MODULE = /^kay(?:\/|$)/
// A module's signals with the stamp of every file they were read from, the module and each one it re-exports from.
const scanned = new Map<string, { stamps: Map<string, string | undefined>, signals: Record<string, SignalKind> }>()

// Inside a scope, what a component's imports exported, found once for all the passes over it: the analysis, the browser and the server compile.
type Memo = Map<string, { source: string, found: ImportedSignals }>
const scope = new AsyncLocalStorage<Memo>()
// Bun calls a plugin back from outside the scope's async context, so while one scope is the only one open its memo answers there too; with two open, a callback without a context looks again.
const open = new Set<Memo>()
// What each component imports, read again only once its text changes.
const imports = new Map<string, { hash: number | bigint | string, specifiers: string[] }>()

// The signals and memos the modules a component imports export, which its template reads and writes as its own; part of every cache key of its compile, so editing such a module compiles the component again.
// A package is left out, its code too large to scan on every compile, unless a relative import reaches into it, as a library's own components do.
export function importedSignals(file: string, source: string): ImportedSignals {
  const memo = scope.getStore() ?? (open.size === 1 ? open.values().next().value : undefined)
  const memoized = memo?.get(file)

  if (memoized?.source === source)
    return memoized.found

  const found = readImportedSignals(file, source)

  memo?.set(file, { source, found })

  return found
}

// A build, or one of the dev builder's rebuilds, runs inside a scope: the files do not change meanwhile, so each component's signals are looked up once instead of once per pass, and the next scope starts from the disk again.
// Outside one, as in a server compiling on a request or the language server, every call looks again, and two scopes open at once each answer only the calls inside it.
export async function inSignalsScope<T>(run: () => Promise<T>): Promise<T> {
  if (scope.getStore())
    return run()

  const memo: Memo = new Map()

  open.add(memo)

  try {
    return await scope.run(memo, run)
  }
  finally {
    open.delete(memo)
  }
}

function readImportedSignals(file: string, source: string): ImportedSignals {
  const found: ImportedSignals = {}
  // Under Node, where ESLint runs the processor, Babel reads the imports Bun's transpiler would, and the source is its own key.
  const node = typeof Bun === 'undefined'
  const hash = node ? source : Bun.hash(source)
  const known = imports.get(file)
  let specifiers: string[]

  try {
    specifiers = known?.hash === hash ? known.specifiers : [...new Set(node ? importedModules(fences(source)) : transpilerFor('ts').scanImports(fences(source)).map(entry => entry.path))]
  }
  catch {
    return found
  }

  imports.set(file, { hash, specifiers })

  for (const specifier of specifiers) {
    const path = scannable(specifier, file)

    if (path === undefined)
      continue

    const signals = signalsOf(path)

    if (Object.keys(signals).length > 0)
      found[specifier] = signals
  }

  return found
}

// Forgets what the components not in `files` import, gone or no longer built.
export function keepImportedSignals(files: ReadonlySet<string>): void {
  for (const file of imports.keys()) {
    if (!files.has(file))
      imports.delete(file)
  }
}

// The file a specifier names when its signals are worth scanning: a script or a component, not a `kay` entry, and a package only through a relative import.
function scannable(specifier: string, from: string): string | undefined {
  const path = KAY_MODULE.test(specifier) ? undefined : resolveFrom(specifier, from)

  return path === undefined || !(SCRIPT_FILE.test(path) || KAY_FILE.test(path)) || (!specifier.startsWith('.') && path.includes('/node_modules/')) ? undefined : path
}

function stampOf(path: string): string | undefined {
  const stats = statSync(path, { throwIfNoEntry: false })

  return stats && `${stats.mtimeMs}-${stats.size}`
}

// What a module exports, read again once the stamp of it or of a module it re-exports from changes.
function signalsOf(path: string): Record<string, SignalKind> {
  try {
    const known = scanned.get(path)

    if (known && [...known.stamps].every(([file, stamp]) => stampOf(file) === stamp))
      return known.signals

    const stamps = new Map<string, string | undefined>()
    const signals = collect(path, { stamps, done: new Map(), cuts: 0 }, [])

    scanned.set(path, { stamps, signals })

    return signals
  }
  catch {
    return {}
  }
}

// One scan of a module: the stamps of the files it read, what each finished module exported, and how many times a cycle cut a read short, a module read under a cut being incomplete and so not kept.
interface Scan {
  stamps: Map<string, string | undefined>
  done: Map<string, Record<string, SignalKind>>
  cuts: number
}

// The signals a module exports, those it hands on from another included; `trail` is the modules being read, so a cycle of re-exports ends.
function collect(path: string, scan: Scan, trail: string[]): Record<string, SignalKind> {
  const kept = scan.done.get(path)

  if (kept)
    return kept

  const stamp = stampOf(path)

  scan.stamps.set(path, stamp)

  if (stamp === undefined)
    return {}

  if (trail.includes(path)) {
    scan.cuts++

    return {}
  }

  const cuts = scan.cuts
  const text = readFileSync(path, 'utf8')

  if (KAY_FILE.test(path))
    return kindsOf(path, text)

  const { signals, links } = scanModule(text, scriptLoader(path) === 'tsx' || scriptLoader(path) === 'jsx')
  const next = [...trail, path]
  const from = (specifier: string) => {
    const target = scannable(specifier, path)

    return target === undefined ? {} : collect(target, scan, next)
  }

  for (const specifier of links.stars) {
    for (const [name, kind] of Object.entries(from(specifier))) {
      if (name !== 'default' && !Object.hasOwn(signals, name))
        signals[name] = kind
    }
  }

  for (const { exported, source, imported } of links.names) {
    const found = from(source)

    if (Object.hasOwn(found, imported))
      signals[exported] = found[imported]!
  }

  if (scan.cuts === cuts)
    scan.done.set(path, signals)

  return signals
}

function kindsOf(path: string, text: string): Record<string, SignalKind> {
  // A component's signals are the ones its `--- module` fence exports.
  if (KAY_FILE.test(path)) {
    const { module } = parseKay(text)

    return module ? moduleSignals(text.slice(module.start, module.end)) : {}
  }

  return moduleSignals(text, scriptLoader(path) === 'tsx' || scriptLoader(path) === 'jsx')
}
