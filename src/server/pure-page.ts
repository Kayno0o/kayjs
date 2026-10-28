import type { Node } from '@babel/types'
import type { Span } from '../compiler/ast'
import type { KeptImport, KeptSource } from './kept-source'
import type { SourceFile } from './literal-writes'
import type { Unchanged } from './module-state'
import { relative } from 'node:path'
import { findProjectFiles, readSource, resolveFrom } from '../build/files'
import { ICON_IMPORT, iconProps, installedIconSets } from '../build/icons'
import { parseExpanded } from '../compiler/markdown-block'
import { PAGE, PAGE_SETTINGS } from '../compiler/page-settings'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'
import { templateReads } from '../compiler/template-reads'
import { CONTENT_EXPORTS, I18N_EXPORTS, IMAGE_EXPORTS, KAY_EXPORTS } from './kept-exports'
import { readKeptSource } from './kept-source'
import { literalOf, neverWritten } from './literal-writes'
import { exposedBy, firstExportAt, laterExportAt, stateAt, statementState } from './module-state'
import { routeChain } from './routes'

const CODE_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
// A test runs in a process of its own, so what it writes reaches no page.
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
// What a file imported for its bytes holds the same on every render; a database, a native module or a wasm file does not.
const STATIC_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|json|css|txt|md|html|toml|ya?ml|csv)$/i
// The names of exports read as written, not run.
const SETTING_NAMES = new Set<string>([PAGE, ...PAGE_SETTINGS])
const NOT_LINE_BREAK = /[^\n]/g

const STATE = 'declares module state, a `let`, an empty container it fills or an export another module can change'
const KAY_ENTRIES = new Set(['kay', 'kay/i18n', 'kay/image', 'kay/content'])

// A `.kay` file runs its scripts and server fence for each render, so a `let` or an empty container there is state only when the compiler moves its statement to module level, as it does one an export of the server fence reads.
// The offset of the module state in a file, if it holds any, from the parse the scan made of it; `source` is its text with the value of `lastmod` blanked.
function moduleStateAt(file: string, source: string, read: KeptSource, unchanged: Unchanged | undefined, risks: Map<string, number>): number | undefined {
  const { module, server, real } = read.levels
  // A `--- module` fence is all module level, so what it holds is state as in a module of its own.
  const moduleRisks = new Map<string, number>()
  const inModule = module === undefined ? undefined : stateAt(module, SETTING_NAMES, unchanged, moduleRisks)

  if (inModule !== undefined)
    return real(inModule)

  for (const [name, at] of moduleRisks)
    risks.set(name, real(at))

  if (!file.endsWith('.kay') || server === undefined)
    return undefined

  const analysis = analyzeServer(source, parseKay(source).server)

  if (analysis === undefined)
    return undefined

  // A fence being typed, whose statements the compiler cannot place, declares state only when it exports something besides a type or a page setting, which may read it.
  if (analysis.unparsed !== undefined || analysis.broken.length > 0) {
    const at = firstExportAt(server, SETTING_NAMES)

    return at === undefined ? undefined : real(at)
  }

  for (const { start, end } of analysis.exports) {
    const statement = server.body.find(statement => real(statement.start!) >= start && real(statement.end!) <= end && statementState(statement, SETTING_NAMES, unchanged))

    if (statement !== undefined)
      return real(statement.start!)
  }

  const later = laterExportAt(server, SETTING_NAMES, unchanged)

  return later === undefined ? undefined : real(later)
}

// Whether the arguments of a `persisted` call give the options as a literal with no spread and every `storage` in it `'local'`: anything else may be a cookie or the query.
function savesLocally(args: Node[]): boolean {
  const options = args[2]

  // A spread before the options moves them to a place the scan cannot tell.
  if (options?.type !== 'ObjectExpression' || args.some(arg => arg.type === 'SpreadElement'))
    return false

  let local = false

  for (const property of options.properties) {
    // A key the scan cannot read as `storage` or as another name: a spread, a computed one, or `storage` written in quotes.
    if (property.type === 'SpreadElement' || property.computed || (property.key.type === 'StringLiteral' && property.key.value === 'storage'))
      return false

    if (property.key.type !== 'Identifier' || property.key.name !== 'storage')
      continue

    if (property.type !== 'ObjectProperty' || property.value.type !== 'StringLiteral' || property.value.value !== 'local')
      return false

    local = true
  }

  return local
}

// Whether the arguments of a `collection` call start with a folder as a plain string, not a loader.
function startsWithFolder(args: Node[]): boolean {
  const first = args[0]

  return first?.type === 'StringLiteral' || (first?.type === 'TemplateLiteral' && first.expressions.length === 0)
}

// Whether every use of `name` is a call whose arguments `accepts`, and there is one.
function onlyCalls(read: KeptSource, name: string, accepts: (args: Node[]) => boolean): boolean {
  const uses = read.uses.get(name) ?? []

  return uses.length > 0 && uses.every(args => args !== undefined && accepts(args))
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

// The value of the page's `lastmod`: the sitemap reads it, never a render, so a clock in it makes no page depend on one.
function lastmodOf(file: string, source: string): Span | undefined {
  if (!file.endsWith('.kay') || !source.includes('lastmod'))
    return undefined

  return analyzeServer(source, parseKay(source).server)?.page?.settings.get('lastmod')?.value
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

// Every code file of the project, read once per build and parsed when the scan needs it: an exported literal is unchanged only if none of them writes to it.
const projects = new WeakMap<object, Promise<SourceFile[]>>()

async function projectSources(root: string, scans: object): Promise<SourceFile[]> {
  let sources = projects.get(scans)

  if (sources === undefined)
    projects.set(scans, sources = readSources(root))

  return sources
}

async function readSources(root: string): Promise<SourceFile[]> {
  const files = (await findProjectFiles(root, CODE_FILE, { project: true })).filter(file => !TEST_FILE.test(file))

  return files.map((file): SourceFile => {
    try {
      const { text } = readSource(file)

      return { file, text }
    }
    catch {
      // A file that cannot be read may write to anything.
      return { file, text: '', unreadable: true }
    }
  })
}

// Judges an exported object or array literal: unchanged when it is made of literals and no file of the project writes to it or hands it on; without a root nothing is shown.
async function unchangedIn(file: string, read: KeptSource, root: string | undefined, scans: object): Promise<Unchanged | undefined> {
  if (root === undefined || !read.exports)
    return undefined

  const sources = await projectSources(root, scans)

  return (name, initializer) => {
    const literal = literalOf(initializer, read.bindings)

    return literal !== undefined && neverWritten(name, literal, file, sources)
  }
}

// The names of a kay entry's import that are not free for a kept page, or undefined when it takes the whole module.
function impureNames(specifier: string, { names, withDefault }: KeptImport, read: KeptSource): KeptImport['names'] {
  if (names === undefined || withDefault || names.length === 0)
    return undefined

  return names.filter(({ own, local }) => {
    if (specifier === 'kay/i18n')
      return I18N_EXPORTS[own] !== 'free'

    if (specifier === 'kay/image')
      return !Object.hasOwn(IMAGE_EXPORTS, own)

    if (specifier === 'kay/content') {
      const kind = Object.hasOwn(CONTENT_EXPORTS, own) ? CONTENT_EXPORTS[own] : 'request'

      return kind === 'request' || (kind === 'folder' && !onlyCalls(read, local, startsWithFolder))
    }

    const kind = Object.hasOwn(KAY_EXPORTS, own) ? KAY_EXPORTS[own] : 'request'

    return kind === 'request' || (kind === 'local' && !onlyCalls(read, local, savesLocally))
  })
}

// Why a page importing `impure` of a kay entry is not kept, `implicit` when the file reads them with no import.
function impureWhy(specifier: string, impure: KeptImport['names'], implicit: boolean): string {
  const what = impure === undefined ? 'the whole module' : impure.map(({ text }) => `\`${text}\``).join(', ')

  if (specifier === 'kay/image')
    return `imports ${what} from \`kay/image\`, which a request can change`

  if (specifier === 'kay/content' && impure !== undefined && impure.every(({ own }) => own === 'collection'))
    return 'calls `collection` with something other than a folder written as a string, a loader that may read a database or refresh on a `ttl`, which no rebuild tells the page of'

  return `${implicit ? 'reads' : 'imports'} ${what} from \`${specifier}\`, which a request or the clock can change`
}

async function scanned(file: string, root: string | undefined, scans: object): Promise<Scan> {
  const raw = readSource(file).text
  const lastmod = lastmodOf(file, raw)
  // The source the state rules read, with the value of `lastmod` blanked, line breaks kept.
  const source = lastmod === undefined ? raw : raw.slice(0, lastmod.start) + raw.slice(lastmod.start, lastmod.end).replace(NOT_LINE_BREAK, ' ') + raw.slice(lastmod.end)
  const read = readKeptSource(file, raw, lastmod)
  const code: string[] = []
  const stopAt = (at: number, why: string): Scan => ({ stop: { file, line: lineAt(source, at), why }, code })

  if (read.unparsed !== undefined)
    return stopAt(read.unparsed, 'does not parse, so nothing shows what it reads')

  if (read.read !== undefined && (read.ctx === undefined || read.read.at < read.ctx))
    return stopAt(read.read.at, `reads \`${read.read.what}\``)

  if (read.ctx !== undefined)
    return stopAt(read.ctx, 'reads `ctx`')

  const risks = new Map<string, number>()
  const state = moduleStateAt(file, source, read, await unchangedIn(file, read, root, scans), risks)

  if (state !== undefined)
    return stopAt(state, STATE)

  const exposed = new Map([...read.levels.module === undefined ? [] : exposedBy(read.levels.module, risks)].map(([name, at]) => [name, lineAt(source, at)]))
  const taken = new Map<string, ReadonlySet<string> | 'all'>()
  const imports: (KeptImport & { implicit?: boolean })[] = [...read.imports]

  // What a `.kay` file reads of `kay` with no import is judged as if it imported it.
  if (file.endsWith('.kay')) {
    const { file: parts } = parseExpanded(source)
    const server = analyzeServer(parts.source, parts.server)
    const implicit = [...new Set([...analyzeScript(parts.source, parts.script, server?.data.map(({ name }) => name), templateReads(parts), parts.module).implicit, ...server?.implicit ?? []])]

    if (implicit.length > 0)
      imports.push({ specifier: 'kay', at: 0, names: implicit.map(name => ({ own: name, local: name, text: name })), withDefault: false, typesOnly: false, implicit: true })
  }

  // The first stop in the file is the one named.
  imports.sort((a, b) => a.at - b.at)

  for (const imported of imports) {
    const { specifier, at } = imported

    if (KAY_ENTRIES.has(specifier)) {
      if (imported.typesOnly)
        continue

      const impure = impureNames(specifier, imported, read)

      if (impure === undefined || impure.length > 0)
        return stopAt(at, impureWhy(specifier, impure, imported.implicit === true))

      continue
    }

    // An icon of an installed set is a static SVG kay generates, which reads nothing from a request; any other `~icons/` name is left to the app's own resolution, which may reach code.
    if (root !== undefined && installedIcon(root, specifier))
      continue

    if (!specifier.startsWith('.'))
      return stopAt(at, `imports the package \`${specifier}\``)

    const resolved = resolveFrom(specifier, file)

    if (resolved === undefined)
      return stopAt(at, `imports \`${specifier}\`, which does not resolve`)

    if (CODE_FILE.test(resolved)) {
      code.push(resolved)
      taken.set(resolved, merged(taken.get(resolved), importedNames(imported)))
    }
    else if (!STATIC_FILE.test(resolved)) {
      return stopAt(at, `imports \`${specifier}\`, which is neither code nor a data file`)
    }
  }

  return { code, pathname: read.pathname, exposed, taken }
}

// The names an import or re-export takes: `{ A, B as C }` takes A and B, a default `default`, and a namespace, a bare `import` or a `*` everything.
function importedNames({ names, withDefault }: KeptImport): ReadonlySet<string> | 'all' {
  if (names === undefined)
    return 'all'

  const taken = new Set(names.map(({ own }) => own))

  if (withDefault)
    taken.add('default')

  return taken
}

function merged(before: ReadonlySet<string> | 'all' | undefined, names: ReadonlySet<string> | 'all'): ReadonlySet<string> | 'all' {
  return before === 'all' || names === 'all' ? 'all' : new Set([...before ?? [], ...names])
}
