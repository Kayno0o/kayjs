import { resolveFrom } from '../build/files'
import { PAGE, PAGE_SETTINGS } from '../compiler/page-settings'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { routeChain } from './routes'

// What a page may take from `kay` and stay the same for every visitor and every moment: the reactive core and ids, none of which reads a request, a cookie, the environment or a clock.
const PURE_KAY_NAMES = new Set(['signal', 'memo', 'effect', 'batch', 'onCleanup', 'onMount', 'root', 'untrack', 'selection', 'every', 'watch', 'debounced', 'listen', 'linked', 'context', 'uid'])
// The same for `kay/i18n`: messages and formats go by the locale, which is part of the key a copy is kept under; the relative time ones read the clock.
const PURE_I18N_NAMES = new Set(['t', 'T', 'locale', 'localize', 'alternate', 'formatNumber', 'formatDate', 'formatList', 'direction', 'defineMessages'])
const CODE_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
// What a file imported for its bytes holds the same on every render; a database, a native module or a wasm file does not.
const STATIC_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|json|css|txt|md|html|toml|ya?ml|csv)$/i
// Every way a file reads the request or the moment: `ctx`, a clock, a random number, the environment, the file system through Bun, a network fetch, a dynamic import, or a `query` schema, which has the page read the URL's search params.
const READS_REQUEST = /\b(?:ctx|Date|Intl|Temporal|crypto|process|Bun|performance|fetch|globalThis|require|eval)\b|\bMath\b(?!\s*\??\.\s*(?!random\b)\w)|\bimport\s*\(|\bimport\.meta\b|\bquery\s*:/
// State a module keeps from one render to the next, which a second render could show differently: a top-level `let` or `var`, an empty container a cache fills, and a container another module imports and changes.
const MODULE_STATES = [/^(?:export )?(?:let|var) /m, /^(?:export )?const [^=\n]*= *(?:\[ *\]|\{ *\}|new (?:Map|Set|WeakMap|WeakSet|Array|Object)\b)/m]
// An exported literal or `new`, which another module can change; the settings of `page` are read as written, not run.
const SETTING_NAMES = [PAGE, ...PAGE_SETTINGS].join('|')
const EXPORTED_STATE = new RegExp(`^export const (?!(?:${SETTING_NAMES})\\b)[^=\\n]*= *(?:[[{]|new )`, 'm')
// For a server fence the compiler cannot parse, the part of the rule left: it declares state only when it exports something besides a type or a page setting, which may read it.
const MODULE_EXPORT = new RegExp(`^export (?!(?:type|interface) )(?!(?:async )?(?:const|let|var|function) (?:${SETTING_NAMES})\\b)`, 'm')

// What may be a state declaration anywhere on a line, to spare the compiler's view to a file that has none.
const MAYBE_STATE = /\b(?:let|var)\b|=\s*(?:\[\s*\]|\{\s*\}|new\b)/
const LEADING_COMMENTS = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/.*\n\s*)*/

// A `.kay` file runs its scripts and server fence for each render, so a `let` or an empty container there is state only when the compiler moves its statement to module level, as it does one an export of the server fence reads.
function holdsModuleState(file: string, source: string): boolean {
  if (EXPORTED_STATE.test(source))
    return true

  if (!file.endsWith('.kay'))
    return MODULE_STATES.some(state => state.test(source))

  if (!MAYBE_STATE.test(source))
    return false

  const server = analyzeServer(source, parseKay(source).server)

  if (server === undefined)
    return false

  // A fence being typed, whose statements the compiler cannot place, is judged by the file as before.
  if (server.unparsed !== undefined || server.broken.length > 0)
    return MODULE_EXPORT.test(source)

  return server.exports.some(({ start, end }) => MODULE_STATES.some(state => state.test(source.slice(start, end).replace(LEADING_COMMENTS, ''))))
}

// An import or a re-export with what it takes, then one for its effect alone.
const FROM = /\b(?:import|export)\b([^'";(=]*)\sfrom\s*['"]([^'"]+)['"]/g
const FOR_EFFECT = /\bimport\s*['"]([^'"]+)['"]/g
const BRACES = /\{([^}]*)\}/
const AS_NAME = /\s+as\s+(?:\S.*)?$/
const TYPE_NAME = /^type\s/
const TYPE_IMPORT = /^\s*type\b/

export interface Scan {
  // Whether the file reads nothing itself and imports only what the rules allow.
  clean: boolean
  // The files it imports that are code, for the same rules to reach.
  code: string[]
}

// Whether the page, its layouts and everything they import provably read nothing a request or the moment changes, so one render serves every visitor.
// Whatever cannot be shown to is left to render per request: a package, any `kay` entry but its reactive core, a `ctx`, a clock, a `query` schema, module state.
// `scans` keeps what each file holds across the routes of one build.
export async function readsNothing(route: { layouts: string[], file: string }, scans = new Map<string, Promise<Scan>>()): Promise<boolean> {
  const seen = new Set<string>()
  const queue = [...routeChain(route).files]

  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file))
      continue

    seen.add(file)

    let scan = scans.get(file)

    if (scan === undefined)
      scans.set(file, scan = scanned(file))

    const { clean, code } = await scan

    if (!clean)
      return false

    queue.push(...code)
  }

  return true
}

async function scanned(file: string): Promise<Scan> {
  const source = await Bun.file(file).text()
  const code: string[] = []

  if (READS_REQUEST.test(source) || holdsModuleState(file, source))
    return { clean: false, code }

  const imports = [...source.matchAll(FROM)].map(([, clause, specifier]) => ({ clause: clause!, specifier: specifier! }))

  for (const [, specifier] of source.matchAll(FOR_EFFECT))
    imports.push({ clause: '', specifier: specifier! })

  for (const { clause, specifier } of imports) {
    if (TYPE_IMPORT.test(clause))
      continue

    if (specifier === 'kay' || specifier === 'kay/i18n') {
      const imported = (BRACES.exec(clause)?.[1] ?? '').split(',').map(name => name.trim()).filter(name => name !== '' && !TYPE_NAME.test(name))

      if (imported.length === 0 || !imported.every(name => (specifier === 'kay' ? PURE_KAY_NAMES : PURE_I18N_NAMES).has(name.replace(AS_NAME, ''))))
        return { clean: false, code }

      continue
    }

    if (!specifier.startsWith('.'))
      return { clean: false, code }

    const imported = resolveFrom(specifier, file)

    if (imported === undefined)
      return { clean: false, code }

    if (CODE_FILE.test(imported))
      code.push(imported)
    else if (!STATIC_FILE.test(imported))
      return { clean: false, code }
  }

  return { clean: true, code }
}
