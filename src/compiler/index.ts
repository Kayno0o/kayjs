import type { ClassTable } from '../runtime/class-table'
import type { Attribute, Diagnostic, Node, Span } from './ast'
import type { ErrorName } from './errors'
import type { LintLevels } from './lints'
import type { ImportedSignals, SignalKind } from './module-signals'
import type { NameFindings } from './rewrite'
import type { ScriptAnalysis, ServerAnalysis } from './script'
import { basename, relative } from 'node:path'
import process from 'node:process'
import { drawIcons, elementsIn, templateFacts, visitNodes } from './ast'
import { browserReads } from './browser'
import { generate, isInteractive, islandCause, islandMessages, promotionCause, typesAction } from './codegen'
import { asyncReplies, cssImportsWithoutText, separatePageSettings, serverOnlyImports, unboundedFields } from './fence-checks'
import { applyLints, templateLints } from './lints'
import { SourceMap } from './mapping'
import { parseExpanded } from './markdown-block'
import { SELF } from './names'
import { findRewrites } from './rewrite'
import { analyzeScript, analyzeServer } from './script'
import { templateReads } from './template-reads'
import { ISLAND_TWIN } from './twin'
import { validate } from './validate'

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
  // The type of each `query` schema the layouts above this file declare, which its `ctx.query` includes.
  outerQueries?: string[] | undefined
  // Output for type checking: adds the link, form field and island prop assertions.
  check?: boolean | undefined
  relocateImport?: ((specifier: string) => string | undefined) | undefined
  // Code to run: `html` builds server markup as strings, `dom` builds the browser's DOM; type-checking output when unset.
  output?: 'html' | 'dom' | undefined
  // Server output of a build that hydrates: islands carry markers, and a static component renders through its hydratable `?island` twin inside one.
  hydratable?: boolean | undefined
  // Server output of a static component's `?island` twin, which carries markers like an island.
  twinBuild?: boolean | undefined
  // Type checking only: the file is a page of a routes directory, which nothing renders inside an island, so a page without a server fence reads its loops as static as the build does.
  page?: boolean | undefined
  // Type checking only: the level of each lint, over its default.
  lints?: LintLevels | undefined
  // Type checking only: the types alone, for a file whose problems nothing reads, so the ones only `kay check` reports are not looked for.
  typesOnly?: boolean | undefined
  // Renders in the browser only, as `--- client` does: set when a package the component imports cannot load on the server.
  clientOnly?: boolean | undefined
  // Type-checking a static component only islands render: its children render inline with it, so the props it passes them are not serialized.
  insideIsland?: boolean | undefined
  // The signals and memos of the modules the component imports, which it writes by assigning and the check reports read uncalled: `importedSignals` from kay's build finds them.
  importedSignals?: ImportedSignals | undefined
  // The browser's build only: the classes a later Tailwind class overrides, with which literal classes written together resolve while compiling.
  classTable?: ClassTable | undefined
  // The server's build of an app with Tailwind: a shorthand beside a static `class` merges while rendering.
  classMerge?: boolean | undefined
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
  // What makes the component an island, or what may make it one when `promote` is set, as `onClick, line 4`.
  why?: string | undefined
  // The `.class` shorthand names, which CSS tools scanning for class names cannot read off `div.md:flex.w-1/2`.
  classes: string[]
  diagnostics: Diagnostic[]
}

const WORD = /[a-z0-9]+/gi
const LEADING_DIGIT = /^\d/
const KAY_EXTENSION = /\.kay$/
const ACTIONS_FILE = '_actions.kay'
const ERROR_PAGE = '_error.kay'
const LAYOUT = '_layout.kay'
// Rendered by the server around or instead of a page, never inside an island.
const ROUTE_FILES = new Set([LAYOUT, '_404.kay', ERROR_PAGE])
const BACKSLASH = /\\/g
// An icon of an installed set, `~icons/tabler/home`, which the template may draw as a tag.
const ICON_IMPORT = /^~icons\//

// The live values a script imports, which make its component an island: the server changes them and the page follows.
function liveBindings(script: ScriptAnalysis, imported: ImportedSignals | undefined): ScriptAnalysis['imports'] {
  return script.imports.filter(binding => !binding.typeOnly && imported?.[binding.source]?.[binding.imported] === 'live')
}

function liveImport(script: ScriptAnalysis, imported: ImportedSignals | undefined): string | undefined {
  return liveBindings(script, imported)[0]?.local
}

// Whether a component renders as an island of its own, as compileKay decides it, without generating its code.
export function rendersAsIsland(original: string, imported?: ImportedSignals): boolean {
  const { file } = parseExpanded(original)
  const source = file.source
  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, server?.data.map(data => data.name), templateReads(file))

  return file.client !== undefined || isInteractive(file, script) || (file.server === undefined && liveImport(script, imported) !== undefined)
}

// Whether a component is an island, or a static component that may be promoted to one by what it passes, which the build does only when its imports reach an island; a page, a layout and a special page are neither.
export function browserRole(original: string, filename: string, imported?: ImportedSignals): 'island' | 'promotable' | undefined {
  const { file } = parseExpanded(original)
  const source = file.source

  if (file.server !== undefined || ROUTE_FILES.has(basename(filename)))
    return undefined

  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, server?.data.map(data => data.name), templateReads(file))

  if (file.client !== undefined || isInteractive(file, script) || liveImport(script, imported) !== undefined)
    return 'island'

  return promotionCause(file, script) === undefined ? undefined : 'promotable'
}

// The server-only imports in the script of a component the build promotes to an island, which only the project knows: compiling it alone cannot tell whether it is.
export function promotedChecks(original: string): Diagnostic[] {
  const { file } = parseExpanded(original)
  const source = file.source
  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, server?.data.map(data => data.name), templateReads(file))

  return script.fence === undefined ? [] : serverOnlyImports(script.fence)
}

// Compiles a .kay component: to TSX the type checker reads, or with `output` to the HTML strings and DOM code that run.
export function compileKay(original: string, filename: string, options: CompileOptions = {}): CompileResult {
  const { file, expansion, problems } = parseExpanded(original)
  const source = file.source
  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, server?.data.map(data => data.name), templateReads(file))

  drawIcons(file, new Set([...script.imports, ...server?.imports ?? []].filter(binding => !binding.typeOnly && binding.imported === 'default' && ICON_IMPORT.test(binding.source)).map(binding => binding.local)))

  // Pages, layouts and special pages render on the server: a package they import never switches them.
  const routeFile = file.server !== undefined || ROUTE_FILES.has(basename(filename))
  const client = file.client !== undefined || (options.clientOnly === true && !routeFile)
  const live = routeFile ? undefined : liveImport(script, options.importedSignals)
  const island = client || isInteractive(file, script) || live !== undefined ? islandId(filename, options.root) : undefined
  const hydratableServer = options.output === 'html' && options.hydratable === true
  const twin = hydratableServer && !options.twinBuild && island === undefined && !routeFile ? `./${basename(filename)}${ISLAND_TWIN}` : undefined
  const promotion = island === undefined && !routeFile ? promotionCause(file, script) : undefined
  const promote = promotion === undefined ? undefined : islandId(filename, options.root)
  const why = island === undefined ? promotion : islandCause(file, script) ?? (live === undefined ? undefined : `\`${live}\`, a live value`)
  const generateOptions = { classTable: options.classTable, classMerge: options.classMerge, island, client, lives: island === undefined ? undefined : liveBindings(script, options.importedSignals).map(binding => binding.local), twin, promote, output: options.output, hydratable: hydratableServer && (island !== undefined || options.twinBuild === true), moduleId: islandId(filename, options.root), includeServer: options.includeServer, params: options.params, paramTypes: options.paramTypes, outerQueries: options.outerQueries, check: options.check, route: options.check === true && (routeFile || options.page === true), pageFile: routeFile || options.page === true, insideIsland: options.insideIsland, inspect: options.inspect, inspectSource: expansion ? { text: original, real: (offset: number) => expansion.real(offset) } : undefined, relocateImport: options.relocateImport, errorPage: basename(filename) === ERROR_PAGE, special: basename(filename).startsWith('_') && basename(filename) !== LAYOUT }
  // The analysis pass names the component so no read resolves to it, then the name is chosen free of what the code reads.
  const analysis = generate(file, script, server, { ...generateOptions, name: SELF })
  const imported = new Map<string, SignalKind>([...script.imports, ...server?.imports ?? []].flatMap((binding) => {
    const kind = binding.typeOnly ? undefined : options.importedSignals?.[binding.source]?.[binding.imported]

    return kind ? [[binding.local, kind] as const] : []
  }))
  // Only code that runs calls the accessors of rows and aliases; the type checker reads them as values, which it narrows.
  const values = options.output === undefined
  const found = findRewrites({ code: analysis.builder.code, map: analysis.builder.map(), sites: analysis.sites, values, templateStart: file.templateStart, imported, component: componentName(filename), check: options.check, fixedPage: routeFile })
  const fences = [file.script, file.server].map(span => span ? source.slice(span.start, span.end) : '').join('\n')
  const name = freeName(componentName(filename), fences, found.findings.globalReads)
  const final = generate(file, script, server, { ...generateOptions, name, rewrites: found.plan.rewrites, translates: found.plan.translates, values: found.plan.values })
  // A fence that did not parse at all reaches the code unanalysed, so what the rewrites say of its names is only noise beside its syntax error.
  const unparsed = script.unparsed !== undefined || server?.unparsed !== undefined
  const diagnostics = [
    ...coded(file.diagnostics, 'template-syntax'),
    ...coded(file.unclosedServer !== undefined && basename(filename) !== ACTIONS_FILE ? [file.unclosedServer] : [], 'fence-invalid'),
    ...coded(script.diagnostics, 'fence-invalid'),
    ...coded(server?.diagnostics ?? [], 'fence-invalid'),
    ...coded(server ? separatePageSettings(source, server) : [], 'page-settings-invalid'),
    ...coded(validate(file, script, server, generateOptions), 'template-invalid'),
    ...coded(unparsed ? [] : found.diagnostics, 'signal-misuse'),
  ]

  // Code that does not parse usually already has a better diagnostic from the fence or the template; this one is what is left when nothing else explains it.
  if (found.syntaxError && diagnostics.length === 0)
    diagnostics.push(...coded([found.syntaxError], 'fence-syntax'))

  const checked = options.check === true && options.typesOnly !== true

  // Type checking only, so a page still runs while it is fixed, and fails there in development naming the same fixes.
  if (checked && !client)
    diagnostics.push(...coded(browserReads(file, island !== undefined, server?.data.map(data => data.name) ?? [], routeFile), 'browser-only-read'))

  // Code that did not compile may have taken reads and writes with it, so a file with an error is not searched for unread names or unwritten signals.
  const broken = diagnostics.some(diagnostic => !diagnostic.checkOnly)

  if (checked) {
    const fenceLints = [script.fence, server?.fence].flatMap(fence => fence ? [...cssImportsWithoutText(fence), ...asyncReplies(fence)] : [])
    // The script runs in the browser as an island's and in a component only islands render; a static one that may be promoted to an island is read by the project check, which knows whether the build promotes it.
    const browserScript = (island !== undefined || options.insideIsland === true) && !routeFile ? script.fence : undefined
    const unusedLints = broken ? [] : [...unreadNames(source, file.template, script, server, found.findings), ...constantSignals(source, file.script, found.findings)]

    diagnostics.push(...unboundedFields(server), ...fenceLints, ...browserScript === undefined ? [] : serverOnlyImports(browserScript), ...unusedLints, ...templateLints(file))
  }

  if (file.client && routeFile)
    diagnostics.push({ ...file.client, code: 'client-route-fence', message: 'A page, layout or special page cannot be `--- client`', note: 'it renders on the server', help: 'move what needs the browser to a component it renders, and make that one `--- client`' })

  const shorthands = diagnostics.some(diagnostic => (diagnostic.fixes?.length ?? 0) > 0) ? [...elementsIn(file.template)].flatMap(element => element.attributes.filter((attribute): attribute is Shorthand => attribute.kind === 'expression' && attribute.shorthand !== undefined)) : []
  const classes = [...templateFacts(file).classes, ...expansion?.classes(file) ?? []]
  const spelled = (options.check ? applyLints(diagnostics, source, options.lints) : diagnostics).map(diagnostic => spelledOut(diagnostic, shorthands, source))
  const reported = (expansion ? [...spelled.map(diagnostic => expansion.diagnostic(diagnostic)), ...coded(problems, 'template-syntax')] : spelled).sort((a, b) => a.start - b.start)

  // The server never renders a client-only island, so its module leaves the script out: a package touching `window` as it loads never loads there.
  if (client && options.output === 'html' && island !== undefined) {
    // Only the live values it imports stay, so the page it renders in proves them.
    const lives = liveBindings(script, options.importedSignals)
    const imports = lives.map(binding => `import { ${binding.imported} as ${binding.local} } from ${JSON.stringify(binding.source)}\n`).join('')

    return { tsx: `import { island as KayIsland } from 'kay/island'\n${imports}\nexport default KayIsland(${JSON.stringify(island)}, undefined${islandMessages(source, true, lives.map(binding => binding.local), typesAction(script))})\n`, map: new SourceMap([], []), island, why, classes, diagnostics: reported }
  }

  return {
    tsx: final.builder.code,
    map: expansion ? final.builder.map().expanded(expansion) : final.builder.map(),
    island,
    promote,
    why,
    classes,
    diagnostics: reported,
  }
}

type Shorthand = Extract<Attribute, { kind: 'expression' }> & { shorthand: Span }

// A fix editing the name a bare `{title}` shares with its value writes the attribute out, `title={title()}`, as the braces would otherwise hold more than a name.
function spelledOut(diagnostic: Diagnostic, shorthands: Shorthand[], source: string): Diagnostic {
  if (shorthands.length === 0 || !diagnostic.fixes)
    return diagnostic

  const fixes = diagnostic.fixes.map(fix => ({
    ...fix,
    edits: fix.edits.map((edit) => {
      const attribute = shorthands.find(candidate => edit.start >= candidate.name.start && edit.end <= candidate.name.end)

      if (!attribute)
        return edit

      const { name, shorthand } = attribute
      const written = source.slice(name.start, name.end)

      return { ...shorthand, text: `${written}={${written.slice(0, edit.start - name.start)}${edit.text}${written.slice(edit.end - name.start)}}` }
    }),
  }))

  return { ...diagnostic, fixes }
}

// A compile error names the group of messages it belongs to, for `kay explain` to look up; a lint keeps its own name.
function coded(diagnostics: Diagnostic[], code: ErrorName): Diagnostic[] {
  return diagnostics.map(diagnostic => diagnostic.code === undefined ? { ...diagnostic, code } : diagnostic)
}

// Props and server data nothing reads: a prop beside a `...rest` is left out of it on purpose, and a name starting with `_` is unused on purpose, as TypeScript takes it.
function unreadNames(source: string, template: Node[], script: ScriptAnalysis, server: ServerAnalysis | undefined, found: NameFindings): Diagnostic[] {
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
function constantSignals(source: string, script: Span | undefined, found: NameFindings): Diagnostic[] {
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

export function islandId(filename: string, root = process.cwd()): string {
  return relative(root, filename).replace(BACKSLASH, '/')
}

// `todo-item.kay` becomes `TodoItem`, the name stack traces and devtools show.
export function componentName(filename: string): string {
  const words = basename(filename).replace(KAY_EXTENSION, '').match(WORD) ?? []
  const name = words.map(word => word[0]!.toUpperCase() + word.slice(1)).join('')

  return name === '' || LEADING_DIGIT.test(name) ? `Page${name}` : name
}

// A page `table.kay` importing `components/table.kay` would otherwise declare a `Table` that shadows the import and renders itself, and a `date.kay` declaring `function Date` would break the `new Date()` its template reads.
function freeName(name: string, fences: string, reads: ReadonlySet<string>): string {
  return reads.has(name) || new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(fences) ? freeName(`${name}Page`, fences, reads) : name
}
