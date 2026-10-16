import { relative } from 'node:path'
import { resolveFrom } from '../build/files'
import { PAGE, PAGE_SETTINGS } from '../compiler/page-settings'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { stateAt } from './module-state'
import { routeChain } from './routes'

// Every export of `kay` and whether a page importing it stays the same for every visitor and every moment: `free` reads no request, cookie, environment or clock; `request` does, or opens a route, a socket or a call that does; `local` is `persisted`, which reads the request's cookie or query unless it is kept in `localStorage`, read once the page has hydrated, so it is free only where every use says `storage: 'local'`.
// One list, so an export missing from it is found by `tests/kept-pages.test.ts`, which holds it to the exports of `kay`.
export const KAY_EXPORTS: Record<string, 'free' | 'request' | 'local'> = {
  signal: 'free',
  memo: 'free',
  effect: 'free',
  batch: 'free',
  flush: 'free',
  onCleanup: 'free',
  onMount: 'free',
  root: 'free',
  untrack: 'free',
  selection: 'free',
  every: 'free',
  watch: 'free',
  debounced: 'free',
  listen: 'free',
  linked: 'free',
  context: 'free',
  uid: 'free',
  s: 'free',
  describeField: 'free',
  sanitizeHtml: 'free',
  trustHtml: 'free',
  withBase: 'free',
  localPath: 'free',
  markInvalid: 'free',
  focusInvalid: 'free',
  guardLeave: 'free',
  shortcut: 'free',
  navigate: 'free',
  refresh: 'free',
  ActionError: 'free',
  ActionRedirect: 'free',
  ApiError: 'free',
  persisted: 'local',
  queryParam: 'request',
  defer: 'request',
  guard: 'request',
  action: 'request',
  call: 'request',
  dispatch: 'request',
  resource: 'request',
  socket: 'request',
  stream: 'request',
  publicEnv: 'request',
  editing: 'request',
  previewing: 'request',
  logFrom: 'request',
  searchResults: 'request',
  searchSite: 'request',
}

// The same for `kay/i18n`: messages and formats go by the locale, which is part of the key a copy is kept under; the relative time ones read the clock.
const PURE_I18N_NAMES = new Set(['t', 'T', 'locale', 'locales', 'localeName', 'localize', 'alternate', 'formatNumber', 'formatDate', 'formatList', 'direction', 'defineMessages'])
const CODE_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
// What a file imported for its bytes holds the same on every render; a database, a native module or a wasm file does not.
const STATIC_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|json|css|txt|md|html|toml|ya?ml|csv)$/i
// Every way a file reads the request or the moment: `ctx`, a clock, a random number, the environment, the file system through Bun, a network fetch, a dynamic import, or a `query` schema, which has the page read the URL's search params.
const READS_REQUEST = /\b(?:ctx|Date|Intl|Temporal|crypto|process|Bun|performance|fetch|globalThis|require|eval)\b|\bMath\b(?!\s*\??\.\s*(?!random\b)\w)|\bimport\s*\(|\bimport\.meta\b|\bquery\s*:/
// The names of exports read as written, not run.
const SETTING_NAMES = new Set<string>([PAGE, ...PAGE_SETTINGS])
// For a server fence the compiler cannot parse, the part of the rule left: it declares state only when it exports something besides a type or a page setting, which may read it.
const MODULE_EXPORT = new RegExp(`^export (?!(?:type|interface) )(?!(?:async )?(?:const|let|var|function) (?:${[...SETTING_NAMES].join('|')})\\b)`, 'm')

const WHITESPACE = /\s+/g
// What may be a state declaration anywhere on a line, to spare the compiler's view to a file that has none.
const MAYBE_STATE = /\b(?:let|var|export)\b|=\s*(?:\[\s*\]|\{\s*\}|new\b)/

// A `.kay` file runs its scripts and server fence for each render, so a `let` or an empty container there is state only when the compiler moves its statement to module level, as it does one an export of the server fence reads.
// The offset of the module state in a file, if it holds any.
function moduleStateAt(file: string, source: string): number | undefined {
  if (!file.endsWith('.kay'))
    return stateAt(source, SETTING_NAMES)

  if (!MAYBE_STATE.test(source))
    return undefined

  const server = analyzeServer(source, parseKay(source).server)

  if (server === undefined)
    return undefined

  // A fence being typed, whose statements the compiler cannot place, is judged by the file as before.
  if (server.unparsed !== undefined || server.broken.length > 0)
    return MODULE_EXPORT.exec(source)?.index

  for (const { start, end } of server.exports) {
    const at = stateAt(source.slice(start, end), SETTING_NAMES)

    if (at !== undefined)
      return start + at
  }

  return undefined
}

// An import or a re-export with what it takes, then one for its effect alone.
const FROM = /\b(?:import|export)\b([^'";(=]*)\sfrom\s*['"]([^'"]+)['"]/g
const FOR_EFFECT = /\bimport\s*['"]([^'"]+)['"]/g
const BRACES = /\{([^}]*)\}/
const AS_PREFIX = /^.*\sas\s+/
const AS_NAME = /\s+as\s+(?:\S.*)?$/
const TYPE_NAME = /^type\s/
const TYPE_IMPORT = /^\s*type\b/
const LOCAL_STORAGE = /\bstorage\s*:\s*(['"])local\1/
const CALL_OPENING = /^\s*(?:<[^()]*>\s*)?\(/
const REGEX_CHARS = /[$()*+.?[\\\]^{|}]/g

// Whether every use of `name` in `source`, the import itself cut out, is a call saying `storage: 'local'`.
function onlyLocalCalls(source: string, name: string, importAt: number, importLength: number): boolean {
  const rest = source.slice(0, importAt) + source.slice(importAt + importLength)
  const uses = rest.matchAll(new RegExp(`(?<![\\w$.])${name.replace(REGEX_CHARS, '\\$&')}(?![\\w$])`, 'g'))
  let found = false

  for (const use of uses) {
    const after = rest.slice(use.index + name.length)
    const opening = CALL_OPENING.exec(after)

    if (opening === null)
      return false

    let depth = 0
    let end = -1

    for (let at = opening[0].length - 1; at < after.length; at++) {
      if (after[at] === '(')
        depth++
      else if (after[at] === ')')
        depth--

      if (depth === 0) {
        end = at

        break
      }
    }

    if (end === -1 || !LOCAL_STORAGE.test(after.slice(opening[0].length, end)))
      return false

    found = true
  }

  return found
}

// What stops a page from being kept: the file and line that decided it, and what is there; line 0 when a render decided it, not a line of source.
export interface Stop {
  file: string
  line: number
  why: string
}

export interface Scan {
  // What stops the file, when it reads something itself or imports what the rules do not allow.
  stop?: Stop | undefined
  // The files it imports that are code, for the same rules to reach.
  code: string[]
}

// A stop as it reads in a report, its file relative to the project: `src/routes/index.kay:3 reads Date`.
export function describeStop(stop: Stop, root: string): string {
  return `${relative(root, stop.file).replaceAll('\\', '/')}${stop.line > 0 ? `:${stop.line}` : ''} ${stop.why}`
}

function lineAt(source: string, offset: number): number {
  let line = 1

  for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1))
    line++

  return line
}

// Whether the page, its layouts and everything they import provably read nothing a request or the moment changes, so one render serves every visitor.
// Whatever cannot be shown to is left to render per request: a package, any `kay` entry but its reactive core, a `ctx`, a clock, a `query` schema, module state.
// `scans` keeps what each file holds across the routes of one build.
export async function readsNothing(route: { layouts: string[], file: string }, scans = new Map<string, Promise<Scan>>()): Promise<boolean> {
  return await keptStop(route, scans) === undefined
}

// What stops the page from being kept, the first file of it and its layouts, or of what they import, that reads something a request or the moment changes.
export async function keptStop(route: { layouts: string[], file: string }, scans = new Map<string, Promise<Scan>>()): Promise<Stop | undefined> {
  const seen = new Set<string>()
  const queue = [...routeChain(route).files]

  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file))
      continue

    seen.add(file)

    let scan = scans.get(file)

    if (scan === undefined)
      scans.set(file, scan = scanned(file))

    const { stop, code } = await scan

    if (stop !== undefined)
      return stop

    queue.push(...code)
  }

  return undefined
}

async function scanned(file: string): Promise<Scan> {
  const source = await Bun.file(file).text()
  const code: string[] = []

  const reads = READS_REQUEST.exec(source)

  if (reads !== null)
    return { stop: { file, line: lineAt(source, reads.index), why: `reads \`${reads[0].replace(WHITESPACE, '')}\`` }, code }

  const state = moduleStateAt(file, source)

  if (state !== undefined)
    return { stop: { file, line: lineAt(source, state), why: 'declares module state, a `let`, an empty container it fills or an export another module can change' }, code }

  const imports = [...source.matchAll(FROM)].map(match => ({ clause: match[1]!, specifier: match[2]!, index: match.index, length: match[0].length }))

  for (const match of source.matchAll(FOR_EFFECT))
    imports.push({ clause: '', specifier: match[1]!, index: match.index, length: match[0].length })

  // The first stop in the file is the one named.
  imports.sort((a, b) => a.index - b.index)

  for (const { clause, specifier, index, length } of imports) {
    if (TYPE_IMPORT.test(clause))
      continue

    const stop = (why: string): Scan => ({ stop: { file, line: lineAt(source, index), why }, code })

    if (specifier === 'kay' || specifier === 'kay/i18n') {
      const imported = (BRACES.exec(clause)?.[1] ?? '').split(',').map(name => name.trim()).filter(name => name !== '' && !TYPE_NAME.test(name))

      const impure = imported.filter((name) => {
        const own = name.replace(AS_NAME, '')
        const local = name.replace(AS_PREFIX, '')

        if (specifier === 'kay/i18n')
          return !PURE_I18N_NAMES.has(own)

        const kind = Object.hasOwn(KAY_EXPORTS, own) ? KAY_EXPORTS[own] : 'request'

        return kind === 'request' || (kind === 'local' && !onlyLocalCalls(source, local, index, length))
      })

      if (imported.length === 0 || impure.length > 0)
        return stop(`imports ${imported.length === 0 ? 'the whole module' : impure.map(name => `\`${name}\``).join(', ')} from \`${specifier}\`, which a request or the clock can change`)

      continue
    }

    if (!specifier.startsWith('.'))
      return stop(`imports the package \`${specifier}\``)

    const imported = resolveFrom(specifier, file)

    if (imported === undefined)
      return stop(`imports \`${specifier}\`, which does not resolve`)

    if (CODE_FILE.test(imported))
      code.push(imported)
    else if (!STATIC_FILE.test(imported))
      return stop(`imports \`${specifier}\`, which is neither code nor a data file`)
  }

  return { code }
}
