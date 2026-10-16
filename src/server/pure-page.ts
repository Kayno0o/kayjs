import { resolveFrom } from '../build/files'
import { routeChain } from './routes'

// What a page may take from `kay` and stay the same for every visitor and every moment: the reactive core and ids, none of which reads a request, a cookie, the environment or a clock.
const PURE_KAY_NAMES = new Set(['signal', 'memo', 'effect', 'batch', 'onCleanup', 'onMount', 'root', 'untrack', 'selection', 'every', 'watch', 'debounced', 'listen', 'linked', 'context', 'uid'])
const CODE_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
// Every way a file reads the request or the moment: `ctx`, a clock, a random number, the environment, the file system through Bun, a network fetch, a dynamic import, or a `query` schema, which has the page read the URL's search params.
const READS_REQUEST = /\b(?:ctx|Date|Intl|Temporal|crypto|process|Bun|performance|fetch|globalThis|require|eval)\b|Math\s*\.\s*random|\bimport\s*\(|\bimport\.meta\b|\bquery\s*:/
// State a module keeps from one render to the next, which a second render could show differently.
const MODULE_STATE = /^(?:export\s+)?(?:let|var)\s/m
const IMPORT = /\bimport\b([^'";(]*)['"]([^'"]+)['"]/g
const BRACES = /\{([^}]*)\}/
const AS_NAME = /\s+as\s+(?:\S.*)?$/
const TYPE_NAME = /^type\s/
const TYPE_IMPORT = /^\s*type\b/

// Whether the page, its layouts and everything they import provably read nothing a request or the moment changes, so one render serves every visitor.
// Whatever cannot be shown to is left to render per request: a package, any `kay` entry but its reactive core, a `ctx`, a clock, a `query` schema, module state.
export async function readsNothing(route: { layouts: string[], file: string }): Promise<boolean> {
  const seen = new Set<string>()

  for (const file of routeChain(route).files) {
    if (!await pure(file, seen))
      return false
  }

  return true
}

async function pure(file: string, seen: Set<string>): Promise<boolean> {
  if (seen.has(file))
    return true

  seen.add(file)

  const source = await Bun.file(file).text()

  if (READS_REQUEST.test(source) || MODULE_STATE.test(source))
    return false

  for (const [, clause, specifier] of source.matchAll(IMPORT)) {
    if (TYPE_IMPORT.test(clause!))
      continue

    // Messages and formats go by the locale, which is part of the key a copy is kept under.
    if (specifier === 'kay/i18n')
      continue

    if (specifier === 'kay') {
      const imported = (BRACES.exec(clause!)?.[1] ?? '').split(',').map(name => name.trim()).filter(name => name !== '' && !TYPE_NAME.test(name))

      if (imported.length === 0 || !imported.every(name => PURE_KAY_NAMES.has(name.replace(AS_NAME, ''))))
        return false

      continue
    }

    if (!specifier!.startsWith('.'))
      return false

    const imported = resolveFrom(specifier!, file)

    // A picture or a data file is the same on every render.
    if (imported === undefined || (CODE_FILE.test(imported) && !await pure(imported, seen)))
      return false
  }

  return true
}
