import { relative } from 'node:path'
import { resolveFrom } from '../build/files'
import { PAGE, PAGE_SETTINGS } from '../compiler/page-settings'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { stateAt } from './module-state'
import { routeChain } from './routes'

// Every export of `kay` and whether a page importing it stays the same for every visitor and every moment: `free` reads no request, cookie, environment or clock; `request` does, or opens a route, a socket or a call that does.
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

// The same for `kay/content`: `collection` is `folder` because a collection over a folder is compiled by `kay build` and the same for every visitor until the next one, while one over a loader may read a database or refresh on a `ttl` that no invalidation tells the page of; the `request` ones read the files and the edit session now, or write them.
// A page reading a collection is refreshed by `collection.invalidate()`, and one in preview mode is never served a kept copy, so neither makes a folder collection request-bound.
export const CONTENT_EXPORTS: Record<string, 'free' | 'request' | 'folder'> = {
  collection: 'folder',
  isCollection: 'free',
  COLLECTION: 'free',
  reference: 'free',
  imageField: 'free',
  fileField: 'free',
  markdownField: 'free',
  renderMarkdown: 'free',
  bodyHtml: 'free',
  highlightCode: 'free',
  MarkdownError: 'free',
  paginate: 'free',
  isPaginated: 'free',
  collections: 'request',
  collectionInfo: 'request',
  entries: 'request',
  entrySource: 'request',
  entryFile: 'request',
  saveEntry: 'request',
  removeEntry: 'request',
  repositoryRoot: 'request',
}

// The same for `kay/i18n`: messages and formats go by the locale, which is part of the key a copy is kept under; the relative time ones read the clock.
const PURE_I18N_NAMES = new Set(['t', 'T', 'locale', 'locales', 'localeName', 'localize', 'alternate', 'formatNumber', 'formatDate', 'formatList', 'direction', 'defineMessages'])
const CODE_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
// What a file imported for its bytes holds the same on every render; a database, a native module or a wasm file does not.
const STATIC_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|json|css|txt|md|html|toml|ya?ml|csv)$/i
// Every way a file reads the request or the moment besides `ctx`, which `ctxRead` judges: a clock, a random number, the environment, the file system through Bun, a network fetch, a dynamic import, or a `query` schema, which has the page read the URL's search params.
const READS_REQUEST = /\b(?:Date|Intl|Temporal|crypto|process|Bun|performance|fetch|globalThis|require|eval)\b|\bMath\b(?!\s*\??\.\s*(?!random\b)\w)|\bimport\s*\(|\bimport\.meta\b|\bquery\s*:/
// The names of exports read as written, not run.
const SETTING_NAMES = new Set<string>([PAGE, ...PAGE_SETTINGS])
// For a server fence the compiler cannot parse, the part of the rule left: it declares state only when it exports something besides a type or a page setting, which may read it.
const MODULE_EXPORT = new RegExp(`^export (?!(?:type|interface) )(?!(?:async )?(?:const|let|var|function) (?:${[...SETTING_NAMES].join('|')})\\b)`, 'm')

const WHITESPACE = /\s+/g
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

// The source with its comments blanked out, strings, regex literals and templates kept (a `${ }` inside one is scanned as code), so a word in a comment is no use of a name and a comment inside a call's arguments hides nothing.
function withoutComments(source: string): string {
  let result = ''
  // The brace depth each open `${ }` was entered at, to know which `}` closes it.
  const holes: number[] = []
  let braces = 0
  let inTemplate = false

  for (let at = 0; at < source.length; at++) {
    const char = source[at]!
    const next = source[at + 1]
    const regex = !inTemplate && char === '/' && next !== '/' && next !== '*' && BEFORE_REGEX.test(result.slice(-REGEX_LOOKBACK)) ? regexEnd(source, at) : undefined

    if (inTemplate) {
      if (char === '\\') {
        result += source.slice(at, at + 2)
        at++
      }
      else if (char === '$' && next === '{') {
        result += '${'
        at++
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

      result += source.slice(at, end + 1)
      at = end
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
        braces++
      }
      else if (char === '}') {
        braces--

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
export async function keptScan(route: { layouts: string[], file: string }, scans = new Map<string, Promise<Scan>>()): Promise<{ stop?: Stop | undefined, pathname: boolean }> {
  const seen = new Set<string>()
  const queue = [...routeChain(route).files]
  let pathname = false

  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file))
      continue

    seen.add(file)

    let scan = scans.get(file)

    if (scan === undefined)
      scans.set(file, scan = scanned(file))

    const { stop, code, pathname: reads } = await scan

    if (stop !== undefined)
      return { stop, pathname }

    pathname ||= reads === true
    queue.push(...code)
  }

  return { pathname }
}

async function scanned(file: string): Promise<Scan> {
  const source = await Bun.file(file).text()
  const code: string[] = []

  const reads = READS_REQUEST.exec(source)
  const context = ctxRead(source)

  if (reads !== null && (context.stop === undefined || reads.index < context.stop))
    return { stop: { file, line: lineAt(source, reads.index), why: `reads \`${reads[0].replace(WHITESPACE, '')}\`` }, code }

  if (context.stop !== undefined)
    return { stop: { file, line: lineAt(source, context.stop), why: 'reads `ctx`' }, code }

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

        return kind === 'request' || (kind === 'local' && !onlyCalls(source, local, index, length, savesLocally))
      })

      if (imported.length === 0 || impure.length > 0)
        return stop(`imports ${imported.length === 0 ? 'the whole module' : impure.map(name => `\`${name}\``).join(', ')} from \`${specifier}\`, which a request or the clock can change`)

      continue
    }

    if (specifier === 'kay/content') {
      const imported = (BRACES.exec(clause)?.[1] ?? '').split(',').map(name => name.trim()).filter(name => name !== '' && !TYPE_NAME.test(name))

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

  return { code, pathname: context.pathname }
}
