import type { Diagnostic, Node, Span } from './ast'
import type { FoundRewrites } from './rewrite'
import type { ScriptAnalysis, ServerAnalysis } from './script'
import { basename, relative } from 'node:path'
import process from 'node:process'
import { awaitBlocks, tryBlocks } from './ast'
import { browserReads } from './browser'
import { generate, isInteractive, islandMessages } from './codegen'
import { codeFrame } from './frame'
import { positionAt, SourceMap } from './mapping'
import { parseKay } from './parser'
import { findRewrites } from './rewrite'
import { analyzeScript, analyzeServer, unboundedFields } from './script'

export type { Diagnostic } from './ast'
export { SourceMap } from './mapping'

export interface CompileOptions {
  // Island ids are paths relative to this directory, so server and client agree on them.
  root?: string
  // Browser builds pass false so `--- server` code never reaches the bundle.
  includeServer?: boolean
  // Parameters of the route this file serves, typing `ctx.params`.
  params?: string[]
  // A param's type when it is not `string`, such as a matcher's value.
  paramTypes?: Record<string, string>
  // Output for type checking: adds the link, form field and island prop assertions.
  check?: boolean
  relocateImport?: (specifier: string) => string | undefined
  // Code to run: `html` builds server markup as strings, `dom` builds the browser's DOM; type-checking output when unset.
  output?: 'html' | 'dom'
  // Server output of a build that hydrates: islands carry markers, and a static component renders through its hydratable `?island` twin inside one.
  hydratable?: boolean
  // Server output of a static component's `?island` twin, which carries markers like an island.
  twinBuild?: boolean
  // Renders in the browser only, as `--- client` does: set when a package the component imports cannot load on the server.
  clientOnly?: boolean
  // Type-checking a static component only islands render: its children render inline with it, so the props it passes them are not serialized.
  insideIsland?: boolean
}

export interface CompileResult {
  tsx: string
  map: SourceMap
  // Set when the component is interactive and renders as an island.
  island?: string
  // The `.class` shorthand names, which CSS tools scanning for class names cannot read off `div.md:flex.w-1/2`.
  classes: string[]
  diagnostics: Diagnostic[]
}

const WORD = /[a-z0-9]+/gi
const LEADING_DIGIT = /^\d/
const KAY_EXTENSION = /\.kay$/
const ERROR_PAGE = '_error.kay'
// Rendered by the server around or instead of a page, never inside an island.
const ROUTE_FILES = new Set(['_layout.kay', '_404.kay', ERROR_PAGE])
const BACKSLASH = /\\/g

export const ISLAND_TWIN = '?island'

// Whether a component renders as an island of its own, as compileKay decides it, without generating its code.
export function rendersAsIsland(source: string): boolean {
  const file = parseKay(source)
  const server = analyzeServer(source, file.server)

  return file.client !== undefined || isInteractive(file, analyzeScript(source, file.script, server?.data.map(data => data.name)))
}

// The `.kay` file a module path names, its `?island` twin included.
export function withoutTwin(path: string): string {
  return path.endsWith(ISLAND_TWIN) ? path.slice(0, -ISLAND_TWIN.length) : path
}

// Compiles a .kay component: to TSX the type checker reads, or with `output` to the HTML strings and DOM code that run.
export function compileKay(source: string, filename: string, options: CompileOptions = {}): CompileResult {
  const file = parseKay(source)
  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, server?.data.map(data => data.name))
  // A name a fence uses may clash with the component's own; the template's reads are found once the code is generated.
  const fences = [file.script, file.server].map(span => span ? source.slice(span.start, span.end) : '').join('\n')
  let name = freeName(componentName(filename), fences)
  // Pages, layouts and special pages render on the server: a package they import never switches them.
  const routeFile = file.server !== undefined || ROUTE_FILES.has(basename(filename))
  const client = file.client !== undefined || (options.clientOnly === true && !routeFile)
  const island = client || isInteractive(file, script) ? islandId(filename, options.root) : undefined
  const hydratableServer = options.output === 'html' && options.hydratable === true
  const twin = hydratableServer && !options.twinBuild && !island && !routeFile ? `./${basename(filename)}${ISLAND_TWIN}` : undefined
  const generateOptions = { island, client, twin, output: options.output, hydratable: hydratableServer && (island !== undefined || options.twinBuild === true), moduleId: islandId(filename, options.root), includeServer: options.includeServer, params: options.params, paramTypes: options.paramTypes, check: options.check, insideIsland: options.insideIsland, relocateImport: options.relocateImport, errorPage: basename(filename) === ERROR_PAGE, special: basename(filename).startsWith('_') }
  const bindings = [...(script.props?.bindings ?? []), ...(server?.data ?? []).map(data => ({ local: data.local, key: data.name }))]
  let analysis = generate(file, script, server, { ...generateOptions, name })
  // Only code that runs calls the accessors of rows and aliases; the type checker reads them as values, which it narrows.
  const values = options.output === undefined
  let found = findRewrites(analysis.builder.code, analysis.builder.map(), analysis.accessorSites, bindings, name, values)

  // A `date.kay` declaring `function Date` would break the `new Date()` its template reads.
  while (found.shadowsName) {
    name = `${name}Page`
    analysis = generate(file, script, server, { ...generateOptions, name })
    found = findRewrites(analysis.builder.code, analysis.builder.map(), analysis.accessorSites, bindings, name, values)
  }

  const final = generate(file, script, server, { ...generateOptions, name, rewrites: found.rewrites })
  const diagnostics = [...file.diagnostics, ...script.diagnostics, ...(server?.diagnostics ?? []), ...analysis.diagnostics, ...found.diagnostics]

  // Code that does not parse usually already has a better diagnostic from the fence or the template; this one is what is left when nothing else explains it.
  if (found.syntaxError && diagnostics.length === 0)
    diagnostics.push(found.syntaxError)

  // Type checking only, so a page still runs while it is fixed, and fails there in development naming the same fixes.
  if (options.check && !client)
    diagnostics.push(...browserReads(file, island !== undefined, server?.data.map(data => data.name) ?? [], routeFile))

  if (options.check)
    diagnostics.push(...unboundedFields(source, file.server), ...unreadNames(source, script, server, found))

  if (file.client && routeFile)
    diagnostics.push({ ...file.client, message: 'A page, layout or special page renders on the server; only a component it renders can be `--- client`' })

  // The server never renders a client-only island, so its module leaves the script out: a package touching `window` as it loads never loads there.
  if (client && options.output === 'html' && island)
    return { tsx: `import { island as KayIsland } from 'kay/island'\n\nexport default KayIsland(${JSON.stringify(island)}, undefined${islandMessages(source, true)})\n`, map: new SourceMap([], []), island, classes: shorthandClasses(file.template, source), diagnostics: diagnostics.sort((a, b) => a.start - b.start) }

  return {
    tsx: final.builder.code,
    map: final.builder.map(),
    island,
    classes: shorthandClasses(file.template, source),
    diagnostics: diagnostics.sort((a, b) => a.start - b.start),
  }
}

// Props and server data nothing reads: a prop beside a `...rest` is left out of it on purpose, and a name starting with `_` is unused on purpose, as TypeScript takes it.
function unreadNames(source: string, script: ScriptAnalysis, server: ServerAnalysis | undefined, found: FoundRewrites): Diagnostic[] {
  const unread: Diagnostic[] = []
  const unused = (span: Span) => found.unread.has(span.start) && !source.startsWith('_', span.start)

  for (const binding of script.props?.rest ? [] : script.props?.bindings ?? []) {
    if (unused(binding.local))
      unread.push({ ...binding.local, checkOnly: true, message: `The prop \`${binding.key}\` is never read`, fixes: binding.removal && [{ title: `Remove \`${binding.key}\``, edits: [{ ...binding.removal, text: '' }] }] })
  }

  for (const data of server?.data ?? []) {
    if (unused(data.local) && !found.serverReads.has(data.name))
      unread.push({ ...data.local, checkOnly: true, message: `\`${data.name}\` is never read` })
  }

  return unread
}

function shorthandClasses(nodes: Node[], source: string, found: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'element') {
      for (const span of node.classes)
        found.push(source.slice(span.start, span.end))
      shorthandClasses(node.children, source, found)
    }
    else if (node.kind === 'text') {
      shorthandClasses(node.parts.filter(part => part.kind === 'element'), source, found)
    }
    else if (node.kind === 'if') {
      for (const branch of node.branches)
        shorthandClasses(branch.children, source, found)
    }
    else if (node.kind === 'await') {
      shorthandClasses(awaitBlocks(node).flat(), source, found)
    }
    else if (node.kind === 'try') {
      shorthandClasses(tryBlocks(node).flat(), source, found)
    }
    else {
      shorthandClasses([...node.children, ...(node.kind === 'for' ? node.fallback ?? [] : [])], source, found)
    }
  }

  return found
}

export function islandId(filename: string, root = process.cwd()): string {
  return relative(root, filename).replace(BACKSLASH, '/')
}

// `todo-item.kay` becomes `TodoItem`, the name stack traces and devtools show.
export function componentName(filename: string): string {
  const words = basename(filename).replace(KAY_EXTENSION, '').match(WORD) ?? []
  const name = words.map(word => word[0]!.toUpperCase() + word.slice(1)).join('')

  return name === '' || LEADING_DIGIT.test(name) ? `Page${name}` : name
}

// A page `table.kay` importing `components/table.kay` would otherwise declare a `Table` that shadows the import and renders itself.
function freeName(name: string, code: string): string {
  return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code) ? freeName(`${name}Page`, code) : name
}

export function formatDiagnostic(source: string, filename: string, diagnostic: Diagnostic): string {
  const { line, column } = positionAt(source, diagnostic.start)

  return `${filename}:${line}:${column} - ${diagnostic.message}\n${codeFrame(source, diagnostic.start, diagnostic.end)}`
}
