import type { Diagnostic, Node, Span } from './ast'
import type { LintLevels } from './lints'
import type { FoundRewrites } from './rewrite'
import type { ScriptAnalysis, ServerAnalysis } from './script'
import { basename, relative } from 'node:path'
import process from 'node:process'
import { awaitBlocks, drawIcons, tryBlocks, visitNodes } from './ast'
import { browserReads } from './browser'
import { generate, isInteractive, islandMessages, mayPromote } from './codegen'
import { applyLints, templateLints } from './lints'
import { SourceMap } from './mapping'
import { parseKay } from './parser'
import { findRewrites } from './rewrite'
import { analyzeScript, analyzeServer, unboundedFields } from './script'
import { ISLAND_TWIN } from './twin'

export type { Diagnostic } from './ast'
export { formatDiagnostic } from './frame'
export { SourceMap } from './mapping'
export { ISLAND_TWIN, withoutTwin } from './twin'

export interface CompileOptions {
  // Island ids are paths relative to this directory, so server and client agree on them.
  root?: string | undefined
  // Browser builds pass false so `--- server` code never reaches the bundle.
  includeServer?: boolean | undefined
  // Parameters of the route this file serves, typing `ctx.params`.
  params?: string[] | undefined
  // A param's type when it is not `string`, such as a matcher's value.
  paramTypes?: Record<string, string> | undefined
  // Output for type checking: adds the link, form field and island prop assertions.
  check?: boolean | undefined
  relocateImport?: ((specifier: string) => string | undefined) | undefined
  // Code to run: `html` builds server markup as strings, `dom` builds the browser's DOM; type-checking output when unset.
  output?: 'html' | 'dom' | undefined
  // Server output of a build that hydrates: islands carry markers, and a static component renders through its hydratable `?island` twin inside one.
  hydratable?: boolean | undefined
  // Server output of a static component's `?island` twin, which carries markers like an island.
  twinBuild?: boolean | undefined
  // Type checking only: the level of each lint, over its default.
  lints?: LintLevels | undefined
  // Renders in the browser only, as `--- client` does: set when a package the component imports cannot load on the server.
  clientOnly?: boolean | undefined
  // Type-checking a static component only islands render: its children render inline with it, so the props it passes them are not serialized.
  insideIsland?: boolean | undefined
  // Development: every element carries `data-kay-src`, its file and position, for `kay dev`'s inspector.
  inspect?: boolean | undefined
}

export interface CompileResult {
  tsx: string
  map: SourceMap
  // Set when the component is interactive and renders as an island.
  island?: string | undefined
  // Set when the static component renders as an island should it pass one what only an island sends.
  promote?: string | undefined
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
// An icon of an installed set, `~icons/tabler/home`, which the template may draw as a tag.
const ICON_IMPORT = /^~icons\//

// Whether a component renders as an island of its own, as compileKay decides it, without generating its code.
export function rendersAsIsland(source: string): boolean {
  const file = parseKay(source)
  const server = analyzeServer(source, file.server)

  return file.client !== undefined || isInteractive(file, analyzeScript(source, file.script, server?.data.map(data => data.name)))
}

// Compiles a .kay component: to TSX the type checker reads, or with `output` to the HTML strings and DOM code that run.
export function compileKay(source: string, filename: string, options: CompileOptions = {}): CompileResult {
  const file = parseKay(source)
  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, server?.data.map(data => data.name))

  drawIcons(file.template, new Set([...script.imports, ...server?.imports ?? []].filter(binding => !binding.typeOnly && binding.imported === 'default' && ICON_IMPORT.test(binding.source)).map(binding => binding.local)))

  // A name a fence uses may clash with the component's own; the template's reads are found once the code is generated.
  const fences = [file.script, file.server].map(span => span ? source.slice(span.start, span.end) : '').join('\n')
  let name = freeName(componentName(filename), fences)
  // Pages, layouts and special pages render on the server: a package they import never switches them.
  const routeFile = file.server !== undefined || ROUTE_FILES.has(basename(filename))
  const client = file.client !== undefined || (options.clientOnly === true && !routeFile)
  const island = client || isInteractive(file, script) ? islandId(filename, options.root) : undefined
  const hydratableServer = options.output === 'html' && options.hydratable === true
  const twin = hydratableServer && !options.twinBuild && island === undefined && !routeFile ? `./${basename(filename)}${ISLAND_TWIN}` : undefined
  const promote = island === undefined && !routeFile && mayPromote(file, script) ? islandId(filename, options.root) : undefined
  const generateOptions = { island, client, twin, promote, output: options.output, hydratable: hydratableServer && (island !== undefined || options.twinBuild === true), moduleId: islandId(filename, options.root), includeServer: options.includeServer, params: options.params, paramTypes: options.paramTypes, check: options.check, insideIsland: options.insideIsland, inspect: options.inspect, relocateImport: options.relocateImport, errorPage: basename(filename) === ERROR_PAGE, special: basename(filename).startsWith('_') }
  const bindings = [...(script.props?.bindings ?? []), ...(server?.data ?? []).map(data => ({ local: data.local, key: data.name }))]
  let analysis = generate(file, script, server, { ...generateOptions, name })
  // Only code that runs calls the accessors of rows and aliases; the type checker reads them as values, which it narrows.
  const values = options.output === undefined
  let found = findRewrites(analysis.builder.code, analysis.builder.map(), analysis.accessorSites, bindings, name, values, file.templateStart)

  // A `date.kay` declaring `function Date` would break the `new Date()` its template reads.
  while (found.shadowsName) {
    name = `${name}Page`
    analysis = generate(file, script, server, { ...generateOptions, name })
    found = findRewrites(analysis.builder.code, analysis.builder.map(), analysis.accessorSites, bindings, name, values, file.templateStart)
  }

  const final = generate(file, script, server, { ...generateOptions, name, rewrites: found.rewrites })
  const diagnostics = [...file.diagnostics, ...script.diagnostics, ...(server?.diagnostics ?? []), ...analysis.diagnostics, ...found.diagnostics]

  // Code that does not parse usually already has a better diagnostic from the fence or the template; this one is what is left when nothing else explains it.
  if (found.syntaxError && diagnostics.length === 0)
    diagnostics.push(found.syntaxError)

  // Type checking only, so a page still runs while it is fixed, and fails there in development naming the same fixes.
  if (options.check && !client)
    diagnostics.push(...browserReads(file, island !== undefined, server?.data.map(data => data.name) ?? [], routeFile))

  // Code that did not compile may have taken reads and writes with it, so a file with an error is not searched for unread names or unwritten signals.
  const broken = diagnostics.some(diagnostic => !diagnostic.checkOnly)

  if (options.check)
    diagnostics.push(...unboundedFields(source, file.server), ...broken ? [] : [...unreadNames(source, file.template, script, server, found), ...constantSignals(source, file.script, found)], ...templateLints(file))

  if (file.client && routeFile)
    diagnostics.push({ ...file.client, message: 'A page, layout or special page cannot be `--- client`', note: 'it renders on the server', help: 'move what needs the browser to a component it renders, and make that one `--- client`' })

  const reported = (options.check ? applyLints(diagnostics, source, options.lints) : diagnostics).sort((a, b) => a.start - b.start)

  // The server never renders a client-only island, so its module leaves the script out: a package touching `window` as it loads never loads there.
  if (client && options.output === 'html' && island !== undefined)
    return { tsx: `import { island as KayIsland } from 'kay/island'\n\nexport default KayIsland(${JSON.stringify(island)}, undefined${islandMessages(source, true)})\n`, map: new SourceMap([], []), island, classes: shorthandClasses(file.template, source), diagnostics: reported }

  return {
    tsx: final.builder.code,
    map: final.builder.map(),
    island,
    promote,
    classes: shorthandClasses(file.template, source),
    diagnostics: reported,
  }
}

// Props and server data nothing reads: a prop beside a `...rest` is left out of it on purpose, and a name starting with `_` is unused on purpose, as TypeScript takes it.
function unreadNames(source: string, template: Node[], script: ScriptAnalysis, server: ServerAnalysis | undefined, found: FoundRewrites): Diagnostic[] {
  const unread: Diagnostic[] = []
  const unused = (span: Span) => found.unread.has(span.start) && !source.startsWith('_', span.start)
  // A `slot name` reads its prop off the props object, not through the destructured name.
  const slotted = new Set<string>()

  visitNodes(template, (node) => {
    if (node.kind === 'element' && node.outlet)
      slotted.add(source.slice(node.outlet.name.start, node.outlet.name.end))
  })

  for (const binding of script.props?.rest ? [] : script.props?.bindings ?? []) {
    if (unused(binding.local) && !slotted.has(binding.key))
      unread.push({ ...binding.local, checkOnly: true, code: 'unread-name', message: `The prop \`${binding.key}\` is never read`, fixes: binding.removal && [{ title: `Remove \`${binding.key}\``, edits: [{ ...binding.removal, text: '' }], safe: true }] })
  }

  for (const data of server?.data ?? []) {
    if (unused(data.local) && !found.serverReads.has(data.name))
      unread.push({ ...data.local, checkOnly: true, code: 'unread-name', message: `\`${data.name}\` is never read` })
  }

  return unread
}

// The signals the component script declares and nothing writes.
function constantSignals(source: string, script: Span | undefined, found: FoundRewrites): Diagnostic[] {
  return found.constantSignals.filter(({ name }) => script !== undefined && name.start >= script.start && name.end <= script.end).map(({ name, value }) => {
    const text = source.slice(name.start, name.end)

    return {
      ...name,
      code: 'constant-signal',
      message: `\`${text}\` is a signal nothing writes`,
      note: 'it never changes',
      help: value ? `make it a plain value, \`const ${text} = ${source.slice(value.start, value.end)}\`, read as \`${text}\`` : `make it a plain \`const\`, read as \`${text}\``,
      checkOnly: true,
    }
  })
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
