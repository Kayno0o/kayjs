import type { ImportedSignals, Reexported, SignalKind } from '../compiler/module-signals'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync, statSync } from 'node:fs'
import { importedModules, jsonKinds, moduleKinds } from '../compiler/module-signals'
import { parseKay } from '../compiler/parser'
import { resolveFrom, SCRIPT_FILE, scriptLoader, transpilerFor } from './files'
import { fences } from './libraries'

type ImportedKinds = Record<string, SignalKind | 'data'>
const KAY_FILE = /\.kay$/
const JSON_FILE = /\.json$/
// A key of the modules a read depended on that marks a re-export cycle cut short, or a re-export that resolves to nothing: such a read is not remembered, so a module in a cycle is parsed again on each call.
const CUT = '<cycle>'
const MISSING = 'missing'
const KAY_MODULE = /^kay(?:\/|$)/
const scanned = new Map<string, { stamp: string, signals: ImportedKinds, deps: Map<string, string> }>()

// Inside a scope, what a component's imports exported, found once for all the passes over it: the analysis, the browser and the server compile.
type Memo = Map<string, { source: string, found: ImportedSignals }>
const scope = new AsyncLocalStorage<Memo>()
// Bun calls a plugin back from outside the scope's async context, so while one scope is the only one open its memo answers there too; with two open, a callback without a context looks again.
const open = new Set<Memo>()
// What each component imports, read again only once its text changes.
const imports = new Map<string, { hash: number | bigint | string, specifiers: string[] }>()

// The signals and memos the modules a component imports export, and the names they export as literal data, which its template reads and writes as its own; part of every cache key of its compile, so editing such a module compiles the component again.
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
    const path = KAY_MODULE.test(specifier) ? undefined : resolveFrom(specifier, file)

    if (path === undefined || !(SCRIPT_FILE.test(path) || KAY_FILE.test(path) || JSON_FILE.test(path)) || (!specifier.startsWith('.') && path.includes('/node_modules/')))
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

// What a module exports, read again once its stamp, or the stamp of a module it re-exports from, changes.
// `walk` holds the modules being read, so a cycle of re-exports ends, and what a cycle cut short is not remembered.
function signalsOf(path: string, walk = new Set<string>(), deps = new Map<string, string>()): ImportedKinds {
  try {
    const stats = statSync(path, { throwIfNoEntry: false })

    if (!stats) {
      deps.set(path, MISSING)

      return {}
    }

    const stamp = `${stats.mtimeMs}-${stats.size}`
    const known = scanned.get(path)

    deps.set(path, stamp)

    if (known?.stamp === stamp && [...known.deps].every(([dep, depStamp]) => dep === path || (stampOf(dep) ?? MISSING) === depStamp)) {
      for (const [dep, depStamp] of known.deps)
        deps.set(dep, depStamp)

      return known.signals
    }

    if (walk.has(path)) {
      deps.set(CUT, '')

      return {}
    }

    walk.add(path)

    const own = new Map<string, string>([[path, stamp]])
    const text = readFileSync(path, 'utf8')
    const reexported: Reexported = (specifier) => {
      const target = resolveFrom(specifier, path)

      if (target === undefined) {
        own.set(CUT, '')

        return {}
      }

      return SCRIPT_FILE.test(target) || KAY_FILE.test(target) || JSON_FILE.test(target) ? signalsOf(target, walk, own) : {}
    }
    let signals: ImportedKinds

    try {
      signals = kindsOf(path, text, reexported)
    }
    finally {
      walk.delete(path)
    }

    for (const [dep, depStamp] of own)
      deps.set(dep, depStamp)

    if (!own.has(CUT))
      scanned.set(path, { stamp, signals, deps: own })

    return signals
  }
  catch {
    return {}
  }
}

function kindsOf(path: string, text: string, reexported: Reexported): ImportedKinds {
  if (JSON_FILE.test(path))
    return jsonKinds(text)

  // A component's signals are the ones its `--- module` fence exports.
  if (KAY_FILE.test(path))
    return kayModuleSignals(text, reexported)

  return moduleKinds(text, scriptLoader(path) === 'tsx' || scriptLoader(path) === 'jsx', reexported)
}

function stampOf(path: string): string | undefined {
  const stats = statSync(path, { throwIfNoEntry: false })

  return stats && `${stats.mtimeMs}-${stats.size}`
}

function kayModuleSignals(text: string, reexported: Reexported): ImportedKinds {
  const { module } = parseKay(text)

  if (!module)
    return {}

  const fence = text.slice(module.start, module.end)

  return moduleKinds(fence, false, reexported)
}
