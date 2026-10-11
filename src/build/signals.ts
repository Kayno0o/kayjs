import type { ImportedSignals, SignalKind } from '../compiler/module-signals'
import { readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { moduleSignals } from '../compiler/module-signals'
import { scriptLoader, transpilerFor } from './files'
import { fences } from './libraries'

const KAY_MODULE = /^kay(?:\/|$)/
const SCRIPT_MODULE = /\.[cm]?[jt]sx?$/
const scanned = new Map<string, { stamp: string, signals: Record<string, SignalKind> }>()
// What each component imports, read again only once its text changes.
const imports = new Map<string, { source: string, specifiers: string[] }>()

// The signals and memos the modules a component imports export, which its template reads by name; part of every cache key of its compile, so editing such a module compiles the component again.
// A package is left out, its code too large to scan on every compile, unless a relative import reaches into it, as a library's own components do.
export function importedSignals(file: string, source: string): ImportedSignals {
  const found: ImportedSignals = {}
  const known = imports.get(file)
  let specifiers = known?.source === source ? known.specifiers : undefined

  try {
    specifiers ??= [...new Set(transpilerFor('ts').scanImports(fences(source)).map(entry => entry.path))]
  }
  catch {
    return found
  }

  imports.set(file, { source, specifiers })

  for (const specifier of specifiers) {
    const path = KAY_MODULE.test(specifier) ? undefined : resolveFrom(specifier, file)

    if (path === undefined || !SCRIPT_MODULE.test(path) || (!specifier.startsWith('.') && path.includes('/node_modules/')))
      continue

    const signals = signalsOf(path)

    if (Object.keys(signals).length > 0)
      found[specifier] = signals
  }

  return found
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

    const loader = scriptLoader(path)
    const signals = moduleSignals(readFileSync(path, 'utf8'), loader === 'tsx' || loader === 'jsx')

    scanned.set(path, { stamp, signals })

    return signals
  }
  catch {
    return {}
  }
}

function resolveFrom(specifier: string, file: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, dirname(file))
  }
  catch {
    return undefined
  }
}
