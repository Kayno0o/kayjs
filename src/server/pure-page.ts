import type { SourceFile } from './literal-writes'
import type { Unchanged } from './module-state'
import { relative } from 'node:path'
import { findProjectFiles, resolveFrom } from '../build/files'
import { ICON_IMPORT, iconProps, installedIconSets } from '../build/icons'
import { parseExpanded } from '../compiler/markdown-block'
import { PAGE, PAGE_SETTINGS } from '../compiler/page-settings'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'
import { templateReads } from '../compiler/template-reads'
import { neverWritten, parseLiteral } from './literal-writes'
import { exposedBy, laterExportAt, stateAt } from './module-state'
import { routeChain } from './routes'

// Every export of `kay` and whether a page importing it stays the same for every visitor and every moment: `free` reads no request, cookie, environment or clock; `request` does, or opens a route, a socket or a call that does.
// `action` is `free`: it registers a route that answers a POST, which the page's own render never runs, and a kept page is refreshed after the first request that can write.
// `persisted` is `local`: it reads the request's cookie or query, so it is free only where every use says `storage: 'local'`, kept in `localStorage` and read once the page has hydrated.
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
  recipe: 'free',
  defineUi: 'free',
  every: 'free',
  watch: 'free',
  debounced: 'free',
  durationMs: 'free',
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
  route: 'free',
  markInvalid: 'free',
  focusInvalid: 'free',
  elementSize: 'free',
  followLog: 'free',
  guardLeave: 'free',
  shortcut: 'free',
  navigate: 'free',
  refresh: 'free',
  refusalMessage: 'free',
  ActionError: 'free',
  ActionRedirect: 'free',
  ActionRedirectError: 'free',
  ApiError: 'free',
  persisted: 'local',
  queryParam: 'request',
  live: 'request',
  presence: 'request',
  defer: 'request',
  guard: 'request',
  action: 'free',
  call: 'request',
  // Names a route of a module the running server mounted, which a prerender never loads.
  apiUrl: 'request',
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

// The same for `kay/content`: `collection` is `folder` because a collection over a folder is compiled by `kay build` and the same for every visitor until the next one, while one over a loader may read a database or refresh on a `ttl` that no invalidation tells the page of; the `request` ones read the files and the edit session now, or write them.
// A page reading a collection is refreshed by `collection.invalidate()`, and one in preview mode is never served a kept copy, so neither makes a folder collection request-bound.
export const CONTENT_EXPORTS: Record<string, 'free' | 'request' | 'folder'> = {
  collection: 'folder',
  isCollection: 'free',
  COLLECTION: 'free',
  PUBLISH_TIMES: 'free',
  contentKey: 'free',
  reference: 'free',
  imageField: 'free',
  fileField: 'free',
  markdownField: 'free',
  customField: 'free',
  colorField: 'free',
  moneyField: 'free',
  tagsField: 'free',
  linkField: 'free',
  geoField: 'free',
  iconField: 'free',
  findIcons: 'request',
  untranslated: 'free',
  blocks: 'free',
  renderMarkdown: 'free',
  bodyHtml: 'free',
  highlightCode: 'free',
  MarkdownError: 'free',
  paginate: 'free',
  renameField: 'free',
  setField: 'free',
  convertField: 'free',
  unique: 'free',
  fieldInput: 'free',
  isPaginated: 'free',
  collections: 'request',
  collectionInfo: 'request',
  collectionLoader: 'request',
  entryPage: 'request',
  entries: 'request',
  entrySource: 'request',
  entryFile: 'request',
  saveEntries: 'request',
  translations: 'request',
  saveEntry: 'request',
  removeEntry: 'request',
  repositoryRoot: 'request',
}

// The same for `kay/image`: each export is a function of its arguments and of the build's image settings, which a request does not change.
// `shareCard` signs its URL with the build's own key and reads the page's locale, which a kept copy is stored per.
export const IMAGE_EXPORTS: Record<string, 'free'> = {
  image: 'free',
  shareImage: 'free',
  shareCard: 'free',
}

// The same for `kay/i18n`: messages and formats go by the locale, which is part of the key a copy is kept under; the relative time ones read the clock.
const PURE_I18N_NAMES = new Set(['t', 'T', 'locale', 'locales', 'localeName', 'localize', 'alternate', 'formatNumber', 'formatDate', 'formatList', 'direction', 'defineMessages'])
const CODE_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
// An exported `const` that may hold an object or array literal, to spare reading the project to a file that has none.
const SOURCE_BATCH = 64
// A test runs in a process of its own, so what it writes reaches no page.
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const EXPORTED_CONTAINER = /\bexport\s*(?:const\b|default\b|\{)/
// What a file imported for its bytes holds the same on every render; a database, a native module or a wasm file does not.
const STATIC_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|json|css|txt|md|html|toml|ya?ml|csv)$/i
// Every way a file reads the request or the moment besides `ctx`, which `ctxRead` judges: a clock, a random number, the environment, the file system through Bun, a network fetch, a dynamic import, or a `query` schema, which has the page read the URL's search params.
const READS_REQUEST = /\b(?:Date|Intl|Temporal|crypto|process|Bun|performance|fetch|globalThis|require|eval)\b|\bMath\b(?!\s*\??\.\s*(?!random\b)\w)|\bimport\s*\(|\bimport\.meta\b|\bquery\s*:/
// The names of exports read as written, not run.
const SETTING_NAMES = new Set<string>([PAGE, ...PAGE_SETTINGS])
// For a server fence the compiler cannot parse, the part of the rule left: it declares state only when it exports something besides a type or a page setting, which may read it.
const MODULE_EXPORT = new RegExp(`^export (?!(?:type|interface) )(?!(?:async )?(?:const|let|var|function) (?:${[...SETTING_NAMES].join('|')})\\b)`, 'm')

const STATE = 'declares module state, a `let`, an empty container it fills or an export another module can change'
const WHITESPACE = /\s+/g
const NOT_LINE_BREAK = /[^\n]/g
const WORD_CHAR = /[\w$]/
const OPENING_BRACKET = /\[\s*$/
const CLOSING_BRACKET = /^\s*\]/
const SPACE = /\s/
const CTX = /\bctx\b/g
const CTX_PATHNAME = /\s*\??\.\s*url\s*\??\.\s*pathname(?![\w$])(?![ \t]*(?:\+\+|--))(?!\s*(?:=(?!=)|[-+*/%&|^]=|<<=|>>>?=|\*\*=|&&=|\|\|=|\?\?=))/y
const CTX_PARAMS = /\s*\??\.\s*params(?![\w$])/y
// A statement ends at `;`, `,`, `)`, the end of the source, or a line break before a token that cannot continue the expression (`ctx` then `.cookies` on the next line is `ctx.cookies`); `---` closes a .kay fence.
const CTX_ENDS = /[ \t]*(?:[;,)]|$|\r?\n(?!\s*(?:[.?[(`+*/%&|^<>=!:]|-(?!--)|(?:in|instanceof|as|satisfies)(?![\w$]))))/y
const DECLARATION = /(?:^|[^\w$.])(?:const|let|var)$/
// One more than the longest of them.
const DECLARATION_LOOKBACK = 6
const PARAMS_ENTRY = /^params\s*(?::|=|$)/
const URL_ENTRY = /^url\s*:\s*(\{[\s\S]*\})$/
const PATHNAME_ENTRY = /^pathname\s*(?::\s*[\w$]+\s*)?(?:=[\s\S]*)?$/
// What may be a state declaration anywhere on a line, to spare the compiler's view to a file that has none.
const MAYBE_STATE = /\b(?:let|var|export)\b|=\s*(?:\[\s*\]|\{\s*\}|new\b)/

// A `.kay` file runs its scripts and server fence for each render, so a `let` or an empty container there is state only when the compiler moves its statement to module level, as it does one an export of the server fence reads.
// The offset of the module state in a file, if it holds any.
function moduleStateAt(file: string, source: string, unchanged: Unchanged | undefined, risks: Map<string, number>): number | undefined {
  if (!file.endsWith('.kay'))
    return stateAt(source, SETTING_NAMES, unchanged, risks)

  if (!MAYBE_STATE.test(source))
    return undefined

  const { server: fence, module } = parseKay(source)
  const server = analyzeServer(source, fence)

  // A `--- module` fence is all module level, so what it holds is state as in a module of its own.
  const moduleRisks = new Map<string, number>()
  const inModule = module === undefined ? undefined : stateAt(source.slice(module.start, module.end), SETTING_NAMES, unchanged, moduleRisks)

  if (module !== undefined && inModule !== undefined)
    return module.start + inModule

  for (const [name, at] of moduleRisks)
    risks.set(name, module!.start + at)

  if (fence === undefined || server === undefined)
    return undefined

  // A fence being typed, whose statements the compiler cannot place, is judged by the file as before.
  if (server.unparsed !== undefined || server.broken.length > 0)
    return MODULE_EXPORT.exec(source)?.index

  for (const { start, end } of server.exports) {
    const at = stateAt(source.slice(start, end), SETTING_NAMES, unchanged)

    if (at !== undefined)
      return start + at
  }

  const later = laterExportAt(source.slice(fence.start, fence.end), SETTING_NAMES, unchanged)

  return later === undefined ? undefined : fence.start + later
}

// An import or a re-export with what it takes, then one for its effect alone.
const IMPORT_CLAUSE = /\bimport\b([^'";(=]*)\sfrom\s*['"]/g
const FROM = /\b(?:import|export)\b([^'";(=]*)\sfrom\s*['"]([^'"]+)['"]/g
const FOR_EFFECT = /\bimport\s*['"]([^'"]+)['"]/g
const COMMENTS = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g
const BRACES = /\{([^}]*)\}/
const AS_PREFIX = /^.*\sas\s+/
const QUOTES = /^['"]|['"]$/g
const AS_NAME = /\s+as\s+(?:\S.*)?$/
const TYPE_NAME = /^type\s/
const TYPE_IMPORT = /^\s*type\b/
const LOCAL_STORAGE = /^storage\s*:\s*(['"])local\1$/
const NOT_NEWLINE = /[^\n]/g
const FOLDER_LITERAL = /^(?:'[^'\\\n]*'|"[^"\\\n]*"|`[^`\\$]*`)$/
const STORAGE_PROPERTY = /^storage\b/
// A key the scan cannot read as `storage` or as another name: a computed one, or `storage` written in quotes.
const HIDDEN_KEY = /^(?:\[|(['"`])storage\1)/
const CALL_OPENING = /^\s*(?:<[^()]*>\s*)?\(/
const REGEX_CHARS = /[$()*+.?[\\\]^{|}]/g
const OPENERS = '([{'
const CLOSERS = ')]}'

// The parts of `text` between the commas at its own level, up to the bracket that closes the one `text` sits in; brackets, strings and comments inside are skipped.
// Undefined when that bracket never closes.
function splitLevel(text: string): string[] | undefined {
  const parts: string[] = []
  let depth = 1
  let from = 0

  for (let at = 0; at < text.length; at++) {
    const char = text[at]!

    if (char === '"' || char === '\'' || char === '`') {
      for (at++; at < text.length && text[at] !== char; at++) {
        if (text[at] === '\\')
          at++
      }
    }
    else if (char === '/' && text[at + 1] === '/') {
      at = text.indexOf('\n', at)

      if (at === -1)
        return undefined
    }
    else if (char === '/' && text[at + 1] === '*') {
      at = text.indexOf('*/', at + 2)

      if (at === -1)
        return undefined

      at++
    }
    else if (OPENERS.includes(char)) {
      depth++
    }
    else if (CLOSERS.includes(char)) {
      depth--

      if (depth === 0) {
        parts.push(text.slice(from, at))

        return parts
      }
    }
    else if (char === ',' && depth === 1) {
      parts.push(text.slice(from, at))
      from = at + 1
    }
  }

  return undefined
}

// Whether the arguments of a `persisted` call, from just after its `(`, give the options as a literal with no spread and every `storage` in it `'local'`: anything else may be a cookie or the query.
function savesLocally(args: string): boolean {
  const options = splitLevel(args)?.[2]?.trim()

  if (options === undefined || !options.startsWith('{') || !options.endsWith('}'))
    return false

  const properties = splitLevel(options.slice(1))?.map(part => part.trim()).filter(part => part !== '')

  if (properties === undefined || properties.some(property => property.startsWith('...') || HIDDEN_KEY.test(property)))
    return false

  const storage = properties.filter(property => STORAGE_PROPERTY.test(property))

  return storage.length > 0 && storage.every(property => LOCAL_STORAGE.test(property))
}

// Whether the arguments of a `collection` call, from just after its `(`, start with a folder as a plain string, not a loader.
function startsWithFolder(args: string): boolean {
  const first = splitLevel(args)?.[0]?.trim()

  return first !== undefined && FOLDER_LITERAL.test(first)
}

// Where a regex literal may start: after nothing, an operator or an opening bracket, or a keyword that takes an expression.
const BEFORE_REGEX = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|(?<![\w$.])(?:return|typeof|case|do|else|in|of|void|delete|throw|new|yield|await))\s*$/
// How far back `BEFORE_REGEX` needs to look.
const REGEX_LOOKBACK = 16
// How far back a `case` or a label is looked for before its colon.
const BLOCK_LOOKBACK = 80
// A `{` that opens an object literal rather than a block: after one of these a `}` ends a value, so a `/` after it divides.
const BEFORE_VALUE_BRACE = /[(,=[?]\s*$/
const AFTER_COLON = /:\s*$/
// The start of a statement opening with a `case`, a `default` or a label, whose colon has a block after it.
const BLOCK_START = /^\s*(?:case\b|[\w$]+\s*:)/
const STATEMENT_END = /[;{}\n][^;{}\n]*$/

// The statement `before` ends in, from the `;`, `{`, `}` or line break that starts it.
function statementOf(before: string): string {
  const tail = before.slice(-BLOCK_LOOKBACK)
  const found = STATEMENT_END.exec(tail)

  return found === null ? tail : found[0].slice(1)
}

// Whether the `{` coming after `before` opens an object literal: after a colon it does as a property's value or a ternary's branch, and does not after a `case`, `default` or label.
function opensValue(before: string, insideObject: boolean): boolean {
  if (BEFORE_VALUE_BRACE.test(before.slice(-REGEX_LOOKBACK)))
    return true

  return AFTER_COLON.test(before.slice(-REGEX_LOOKBACK)) && (insideObject || !BLOCK_START.test(statementOf(before)))
}

// The offset just after the regex literal starting at `at`, or undefined when its line ends before it closes: then the slash was a division.
function regexEnd(source: string, at: number): number | undefined {
  let inClass = false

  for (let end = at + 1; end < source.length; end++) {
    const char = source[end]

    if (char === '\n')
      return undefined

    if (char === '\\')
      end++
    else if (char === '[')
      inClass = true
    else if (char === ']')
      inClass = false
    else if (char === '/' && !inClass)
      return end + 1
  }

  return undefined
}

// The source with its comments blanked out, and with `mask` the inside of its single or double quoted strings too, as a name in one is no use of it; strings, regex literals and templates kept (a `${ }` inside one is scanned as code), so a word in a comment is no use of a name and a comment inside a call's arguments hides nothing.
function withoutComments(source: string, mask = false): string {
  let result = ''
  // The brace depth each open `${ }` was entered at, to know which `}` closes it.
  const holes: number[] = []
  let braces = 0
  let inTemplate = false
  // Whether each open `{` is an object literal, and the length of `result` right after the last `}` that closed one.
  const literals: boolean[] = []
  let valueEnd = -1

  for (let at = 0; at < source.length; at++) {
    const char = source[at]!
    const next = source[at + 1]
    const regex = !inTemplate && char === '/' && next !== '/' && next !== '*' && BEFORE_REGEX.test(result.slice(-REGEX_LOOKBACK)) && result.trimEnd().length !== valueEnd ? regexEnd(source, at) : undefined

    if (inTemplate) {
      if (char === '\\') {
        result += source.slice(at, at + 2)
        at++
      }
      else if (char === '$' && next === '{') {
        result += '${'
        at++
        literals.push(false)
        holes.push(braces++)
        inTemplate = false
      }
      else {
        result += char

        if (char === '`')
          inTemplate = false
      }
    }
    else if (char === '`') {
      result += char
      inTemplate = true
    }
    else if (char === '"' || char === '\'') {
      let end = at + 1

      for (; end < source.length && source[end] !== char; end++) {
        if (source[end] === '\\')
          end++
      }

      // Masking blanks only a string that closes on its line and does not follow a word, so an apostrophe in prose opens none.
      const closed = source[end] === char && !source.slice(at, end).includes('\n') && !WORD_CHAR.test(source[at - 1] ?? '')

      if (mask && !closed) {
        result += char
      }
      else if (mask) {
        const key = OPENING_BRACKET.test(result.slice(-20)) && CLOSING_BRACKET.test(source.slice(end + 1, end + 8))

        result += char + (key ? source.slice(at + 1, end) : source.slice(at + 1, end).replace(NOT_LINE_BREAK, ' ')) + char
        at = end
      }
      else {
        result += source.slice(at, end + 1)
        at = end
      }
    }
    else if (char === '/' && (next === '/' || next === '*')) {
      const line = next === '/'
      const found = line ? source.indexOf('\n', at) : source.indexOf('*/', at + 2)
      let end = source.length

      if (found !== -1)
        end = line ? found : found + 2

      result += source.slice(at, end).replace(NOT_NEWLINE, ' ')
      at = end - 1
    }
    else if (regex !== undefined) {
      result += source.slice(at, regex)
      at = regex - 1
    }
    else {
      if (char === '{') {
        literals.push(opensValue(result, literals.at(-1) === true))
        braces++
      }
      else if (char === '}') {
        braces--
        // The length `result` will have once this `}` is appended, so a `/` right after it reads as a division.
        valueEnd = literals.pop() === true ? result.length + 1 : -1

        if (holes.at(-1) === braces) {
          holes.pop()
          inTemplate = true
        }
      }

      result += char
    }
  }

  return result
}

// Whether every use of `name` in `source`, the import itself cut out, is a call whose arguments `accepts`.
function onlyCalls(source: string, name: string, importAt: number, importLength: number, accepts: (args: string) => boolean): boolean {
  const rest = withoutComments(source.slice(0, importAt) + source.slice(importAt + importLength))
  const uses = rest.matchAll(new RegExp(`(?<![\\w$.])${name.replace(REGEX_CHARS, '\\$&')}(?![\\w$])`, 'g'))
  let found = false

  for (const use of uses) {
    const after = rest.slice(use.index + name.length)
    const opening = CALL_OPENING.exec(after)

    if (opening === null || !accepts(after.slice(opening[0].length)))
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
  // It reads `ctx.url.pathname`, so a copy of the page is right only for the pathname it was rendered at.
  pathname?: boolean | undefined
  // The line of the exported container nothing proves unchanged that each of its exports leans on, which stops a page only when it takes that export.
  exposed?: Map<string, number> | undefined
  // The names it takes from each file it imports, or all of them.
  taken?: Map<string, ReadonlySet<string> | 'all'> | undefined
}

// A stop as it reads in a report, its file relative to the project: `src/routes/index.kay:3 reads Date`.
export function describeStop(stop: Stop, root: string): string {
  return `${relative(root, stop.file).replaceAll('\\', '/')}${stop.line > 0 ? `:${stop.line}` : ''} ${stop.why}`
}

// Whether a destructuring pattern `{ ... }` of `ctx` takes only what its own path fixes: `params`, and `url` narrowed to `pathname`.
// Gives whether it takes the pathname, or undefined when it takes anything else, the whole `url` and a rest element included.
function destructuredPath(pattern: string): boolean | undefined {
  const entries = splitLevel(pattern.slice(1))?.map(part => part.trim()).filter(part => part !== '')

  if (entries === undefined)
    return undefined

  let pathname = false

  for (const entry of entries) {
    if (PARAMS_ENTRY.test(entry))
      continue

    const url = URL_ENTRY.exec(entry)?.[1]
    const inner = url === undefined ? undefined : splitLevel(url.slice(1))?.map(part => part.trim()).filter(part => part !== '')

    if (inner === undefined || !inner.every(part => PATHNAME_ENTRY.test(part)))
      return undefined

    pathname ||= inner.length > 0
  }

  return pathname
}

// The offset just after the last non-space character before `end`.
function trimmedEnd(source: string, end: number): number {
  let at = end

  while (at > 0 && SPACE.test(source[at - 1]!))
    at--

  return at
}

// The `{ ... }` pattern a `const`, `let` or `var` binds to `ctx`, when the text before the `ctx` at `index` is `const { ... } = `.
function patternBefore(source: string, index: number): string | undefined {
  const head = trimmedEnd(source, index)

  if (source[head - 1] !== '=' || source[head - 2] === '=')
    return undefined

  const end = trimmedEnd(source, head - 1)

  if (source[end - 1] !== '}')
    return undefined

  let depth = 0

  for (let at = end - 1; at >= 0; at--) {
    if (source[at] === '}') {
      depth++
    }
    else if (source[at] === '{' && --depth === 0) {
      const declared = trimmedEnd(source, at)

      return DECLARATION.test(source.slice(Math.max(0, declared - DECLARATION_LOOKBACK), declared)) ? source.slice(at, end) : undefined
    }
  }

  return undefined
}

// What a file does with `ctx`: the offset of the first use that reads more than its path fixes, and whether it reads the pathname.
// Only `ctx.url.pathname`, `ctx.params` and a `const { params, url: { pathname } } = ctx` are followed; any other use, `ctx` passed on, aliased, or read at `url`, `search`, `request`, `cookies` or `headers`, is a read of the request.
// A kept copy is served for the one pathname it was rendered at, and a page has no params to read, so neither is a request read.
function ctxRead(source: string): { stop?: number | undefined, pathname: boolean } {
  let pathname = false

  const follows = (pattern: RegExp, from: number): boolean => {
    pattern.lastIndex = from

    return pattern.test(source)
  }

  for (const { index } of source.matchAll(CTX)) {
    const after = index + 3

    if (source[trimmedEnd(source, index) - 1] === '.')
      return { stop: index, pathname }

    if (follows(CTX_PATHNAME, after)) {
      pathname = true

      continue
    }

    if (follows(CTX_PARAMS, after))
      continue

    const pattern = follows(CTX_ENDS, after) ? patternBefore(source, index) : undefined
    const taken = pattern === undefined ? undefined : destructuredPath(pattern)

    if (taken === undefined)
      return { stop: index, pathname }

    pathname ||= taken
  }

  return { pathname }
}

function lineAt(source: string, offset: number): number {
  let line = 1

  for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1))
    line++

  return line
}

// Whether the page, its layouts and everything they import provably read nothing a request or the moment changes, so one render serves every visitor, and whether any of them read the pathname: the page is then right only at the path it is rendered at.
// Whatever cannot be shown to is left to render per request: a package, any `kay` export `KAY_EXPORTS` does not class as free, a `ctx`, a clock, a `query` schema, module state.
// `stop` is the first file of the page and its layouts, or of what they import, that reads something a request or the moment changes.
// `scans` keeps what each file holds across the routes of one build.
export async function keptScan(route: { layouts: string[], file: string }, scans = new Map<string, Promise<Scan>>(), root?: string): Promise<{ stop?: Stop | undefined, pathname: boolean }> {
  const seen = new Set<string>()
  const queue = [...routeChain(route).files]
  const takes = new Map<string, ReadonlySet<string> | 'all'>()
  let pathname = false

  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file))
      continue

    seen.add(file)

    let scan = scans.get(file)

    if (scan === undefined)
      scans.set(file, scan = scanned(file, root, scans))

    const { stop, code, pathname: reads, taken } = await scan

    if (stop !== undefined)
      return { stop, pathname }

    pathname ||= reads === true
    queue.push(...code)

    for (const [imported, names] of taken ?? [])
      takes.set(imported, merged(takes.get(imported), names))
  }

  // An exported container nothing proves unchanged stops a page that takes it, or what leans on it.
  for (const file of seen) {
    const { exposed } = await scans.get(file)!
    const names = takes.get(file)
    const line = names === 'all' ? exposed?.values().next().value : [...names ?? []].map(name => exposed?.get(name)).find(at => at !== undefined)

    if (line !== undefined)
      return { stop: { file, line, why: STATE }, pathname }
  }

  return { pathname }
}

// The source with the value of the page's `lastmod` blanked, line breaks kept: the sitemap reads it, never a render, so a clock in it makes no page depend on one.
function withoutLastmod(file: string, source: string): string {
  if (!file.endsWith('.kay') || !source.includes('lastmod'))
    return source

  const value = analyzeServer(source, parseKay(source).server)?.page?.settings.get('lastmod')?.value

  return value === undefined ? source : source.slice(0, value.start) + source.slice(value.start, value.end).replace(NOT_LINE_BREAK, ' ') + source.slice(value.end)
}

const installed = new Map<string, Map<string, string>>()

function installedIcon(root: string, specifier: string): boolean {
  const [, prefix, name] = ICON_IMPORT.exec(specifier) ?? []

  if (prefix === undefined)
    return false

  let sets = installed.get(root)

  if (sets === undefined)
    installed.set(root, sets = installedIconSets(root))

  const file = sets.get(prefix)

  return file !== undefined && iconProps(file, name!) !== undefined
}

// Every code file of the project with its comments blanked, read once per build: an exported literal is unchanged only if none of them writes to it.
const projects = new WeakMap<object, Promise<SourceFile[]>>()

async function projectSources(root: string, scans: object): Promise<SourceFile[]> {
  let sources = projects.get(scans)

  if (sources === undefined)
    projects.set(scans, sources = readSources(root))

  return sources
}

async function readSources(root: string): Promise<SourceFile[]> {
  const files = (await findProjectFiles(root, CODE_FILE, { project: true })).filter(file => !TEST_FILE.test(file))
  const sources: SourceFile[] = []

  for (let from = 0; from < files.length; from += SOURCE_BATCH) {
    sources.push(...await Promise.all(files.slice(from, from + SOURCE_BATCH).map(async (file): Promise<SourceFile> => {
      try {
        const text = await Bun.file(file).text()

        return { file, text: withoutComments(text), code: withoutComments(text, true) }
      }
      catch {
        // A file that cannot be read may write to anything.
        return { file, text: '', code: '', unreadable: true }
      }
    })))
  }

  return sources
}

// Judges an exported object or array literal: unchanged when it is made of literals and no file of the project writes to it or hands it on; without a root nothing is shown.
async function unchangedIn(file: string, source: string, root: string | undefined, scans: object): Promise<Unchanged | undefined> {
  if (root === undefined || !EXPORTED_CONTAINER.test(source))
    return undefined

  const sources = await projectSources(root, scans)
  const imported = importedBindings(source)

  return (name, initializer) => {
    const literal = parseLiteral(initializer, imported)

    return literal !== undefined && neverWritten(name, literal, file, sources)
  }
}

// The names a module's imports bind, a namespace and a type apart.
function importedBindings(source: string): Set<string> {
  const names = new Set<string>()

  for (const [, clause] of withoutComments(source).matchAll(IMPORT_CLAUSE)) {
    if (clause!.includes('*') || TYPE_IMPORT.test(clause!))
      continue

    for (const entry of importList(clause!))
      names.add(entry.replace(AS_PREFIX, ''))

    const fallback = clause!.replace(BRACES, '').replaceAll(',', '').trim()

    if (fallback !== '')
      names.add(fallback)
  }

  return names
}

async function scanned(file: string, root: string | undefined, scans: object): Promise<Scan> {
  const source = withoutLastmod(file, await Bun.file(file).text())
  const code: string[] = []

  const reads = READS_REQUEST.exec(source)
  const context = ctxRead(source)

  if (reads !== null && (context.stop === undefined || reads.index < context.stop))
    return { stop: { file, line: lineAt(source, reads.index), why: `reads \`${reads[0].replace(WHITESPACE, '')}\`` }, code }

  if (context.stop !== undefined)
    return { stop: { file, line: lineAt(source, context.stop), why: 'reads `ctx`' }, code }

  const risks = new Map<string, number>()
  const state = moduleStateAt(file, source, await unchangedIn(file, source, root, scans), risks)

  if (state !== undefined)
    return { stop: { file, line: lineAt(source, state), why: STATE }, code }

  const exposed = new Map([...exposedBy(source, risks)].map(([name, at]) => [name, lineAt(source, at)]))
  const taken = new Map<string, ReadonlySet<string> | 'all'>()

  const bare = withoutComments(source)
  const imports = [...bare.matchAll(FROM)].map(match => ({ clause: match[1]!, specifier: match[2]!, index: match.index, length: match[0].length }))

  for (const match of bare.matchAll(FOR_EFFECT))
    imports.push({ clause: '', specifier: match[1]!, index: match.index, length: match[0].length })

  // What a `.kay` file reads of `kay` with no import is judged as if it imported it.
  if (file.endsWith('.kay')) {
    const { file: parts } = parseExpanded(source)
    const server = analyzeServer(parts.source, parts.server)
    const implicit = [...new Set([...analyzeScript(parts.source, parts.script, server?.data.map(({ name }) => name), templateReads(parts)).implicit, ...server?.implicit ?? []])]

    if (implicit.length > 0)
      imports.push({ clause: `{ ${implicit.join(', ')} }`, specifier: 'kay', index: 0, length: 0 })
  }

  // The first stop in the file is the one named.
  imports.sort((a, b) => a.index - b.index)

  for (const { clause, specifier, index, length } of imports) {
    if (TYPE_IMPORT.test(clause))
      continue

    const stop = (why: string): Scan => ({ stop: { file, line: lineAt(source, index), why }, code })

    if (specifier === 'kay' || specifier === 'kay/i18n') {
      const imported = importList(clause)

      const impure = imported.filter((name) => {
        const own = name.replace(AS_NAME, '')
        const local = name.replace(AS_PREFIX, '')

        if (specifier === 'kay/i18n')
          return !PURE_I18N_NAMES.has(own)

        const kind = Object.hasOwn(KAY_EXPORTS, own) ? KAY_EXPORTS[own] : 'request'

        return kind === 'request' || (kind === 'local' && !onlyCalls(source, local, index, length, savesLocally))
      })

      if (imported.length === 0 || impure.length > 0)
        return stop(`${length === 0 ? 'reads' : 'imports'} ${imported.length === 0 ? 'the whole module' : impure.map(name => `\`${name}\``).join(', ')} from \`${specifier}\`, which a request or the clock can change`)

      continue
    }

    if (specifier === 'kay/image') {
      const imported = importList(clause)
      const impure = imported.filter(name => !Object.hasOwn(IMAGE_EXPORTS, name.replace(AS_NAME, '')))

      if (imported.length === 0 || impure.length > 0)
        return stop(`imports ${imported.length === 0 ? 'the whole module' : impure.map(name => `\`${name}\``).join(', ')} from \`kay/image\`, which a request can change`)

      continue
    }

    if (specifier === 'kay/content') {
      const imported = importList(clause)

      const impure = imported.filter((name) => {
        const own = name.replace(AS_NAME, '')
        const kind = Object.hasOwn(CONTENT_EXPORTS, own) ? CONTENT_EXPORTS[own] : 'request'

        return kind === 'request' || (kind === 'folder' && !onlyCalls(source, name.replace(AS_PREFIX, ''), index, length, startsWithFolder))
      })

      if (imported.length === 0 || impure.length > 0) {
        const loader = impure.length > 0 && impure.every(name => name.replace(AS_NAME, '') === 'collection')

        return stop(loader
          ? 'calls `collection` with something other than a folder written as a string, a loader that may read a database or refresh on a `ttl`, which no rebuild tells the page of'
          : `imports ${imported.length === 0 ? 'the whole module' : impure.map(name => `\`${name}\``).join(', ')} from \`kay/content\`, which a request or the clock can change`)
      }

      continue
    }

    // An icon of an installed set is a static SVG kay generates, which reads nothing from a request; any other `~icons/` name is left to the app's own resolution, which may reach code.
    if (root !== undefined && installedIcon(root, specifier))
      continue

    if (!specifier.startsWith('.'))
      return stop(`imports the package \`${specifier}\``)

    const imported = resolveFrom(specifier, file)

    if (imported === undefined)
      return stop(`imports \`${specifier}\`, which does not resolve`)

    if (CODE_FILE.test(imported)) {
      code.push(imported)
      taken.set(imported, merged(taken.get(imported), importedNames(clause)))
    }
    else if (!STATIC_FILE.test(imported)) {
      return stop(`imports \`${specifier}\`, which is neither code nor a data file`)
    }
  }

  return { code, pathname: context.pathname, exposed, taken }
}

// The entries an import or export clause lists in braces, a `type` one left out.
function importList(clause: string): string[] {
  return (BRACES.exec(clause.replace(COMMENTS, ' '))?.[1] ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== '' && !TYPE_NAME.test(entry))
}

// The names an import or re-export clause takes: `{ A, B as C }` takes A and B, a default `default`, and a namespace, a bare `import` or a `*` everything.
function importedNames(clause: string): ReadonlySet<string> | 'all' {
  if (clause.includes('*') || clause.trim() === '')
    return 'all'

  const names = new Set(importList(clause).map(entry => entry.replace(AS_NAME, '').replace(QUOTES, '')))

  if (clause.replace(BRACES, '').replaceAll(',', '').trim() !== '')
    names.add('default')

  return names
}

function merged(before: ReadonlySet<string> | 'all' | undefined, names: ReadonlySet<string> | 'all'): ReadonlySet<string> | 'all' {
  return before === 'all' || names === 'all' ? 'all' : new Set([...before ?? [], ...names])
}
