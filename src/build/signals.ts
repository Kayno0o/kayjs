import type { ImportedSignals, SignalKind } from '../compiler/module-signals'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync, statSync } from 'node:fs'
import { moduleSignals } from '../compiler/module-signals'
import { parseKay } from '../compiler/parser'
import { resolveFrom, SCRIPT_FILE, scriptLoader, transpilerFor } from './files'
import { fences } from './libraries'

const KAY_FILE = /\.kay$/
const KAY_MODULE = /^kay(?:\/|$)/
const scanned = new Map<string, { stamp: string, signals: Record<string, SignalKind> }>()

// Inside a scope, what a component's imports exported, found once for all the passes over it: the analysis, the browser and the server compile.
type Memo = Map<string, { source: string, found: ImportedSignals }>
const scope = new AsyncLocalStorage<Memo>()
// Bun calls a plugin back from outside the scope's async context, so while one scope is the only one open its memo answers there too; with two open, a callback without a context looks again.
const open = new Set<Memo>()
// What each component imports, read again only once its text changes.
const imports = new Map<string, { hash: number | bigint, specifiers: string[] }>()

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
  let hash: number | bigint
  let specifiers: string[]

  try {
    // Under Node, where the ESLint processor runs this, there is no transpiler: nothing is hashed or scanned.
    const transpiler = transpilerFor('ts')

    hash = Bun.hash(source)
    const known = imports.get(file)

    specifiers = known?.hash === hash ? known.specifiers : [...new Set(transpiler.scanImports(fences(source)).map(entry => entry.path))]
  }
  catch {
    return found
  }

  imports.set(file, { hash, specifiers })

  for (const specifier of specifiers) {
    const path = KAY_MODULE.test(specifier) ? undefined : resolveFrom(specifier, file)

    if (path === undefined || !(SCRIPT_FILE.test(path) || KAY_FILE.test(path)) || (!specifier.startsWith('.') && path.includes('/node_modules/')))
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

function signalsOf(path: string): Record<string, SignalKind> {
  try {
    const stats = statSync(path, { throwIfNoEntry: false })

    if (!stats)
      return {}

    const stamp = `${stats.mtimeMs}-${stats.size}`
    const known = scanned.get(path)

    if (known?.stamp === stamp)
      return known.signals

    const text = readFileSync(path, 'utf8')
    // A component's signals are the ones its `--- module` fence exports.
    const signals = KAY_FILE.test(path) ? kayModuleSignals(text) : moduleSignals(text, scriptLoader(path) === 'tsx' || scriptLoader(path) === 'jsx')

    scanned.set(path, { stamp, signals })

    return signals
  }
  catch {
    return {}
  }
}

function kayModuleSignals(text: string): Record<string, SignalKind> {
  const { module } = parseKay(text)

  return module ? moduleSignals(text.slice(module.start, module.end)) : {}
}
