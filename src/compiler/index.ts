import type { ClassTable } from '../runtime/class-table'
import type { UiEntry } from '../runtime/ui'
import type { Attribute, Diagnostic, KayFile, Node, Span } from './ast'
import type { ErrorName } from './errors'
import type { IslandCause } from './island-cause'
import type { LintLevels } from './lints'
import type { Expansion } from './markdown-block'
import type { ImportedSignals, SignalKind } from './module-signals'
import type { NameFindings } from './rewrite'
import type { ParsedFence, ScriptAnalysis, ServerAnalysis } from './script'
import { basename, relative } from 'node:path'
import { actionOf, drawIcons, elementsIn, INTERACTIVE_ATTRIBUTE, SERVER_IN_ISLAND, serverIslandOf, templateFacts, visitNodes } from './ast'
import { browserReads } from './browser'
import { generate, isInteractive, islandCause, islandMessages, lineOf, promotionSite } from './codegen'
import { asyncReplies, cssImportsWithoutText, missingCaptchas, onceReadProps, openRedirects, separatePageSettings, serverOnlyImports, unboundedFields, unreturnedFails } from './fence-checks'
import { cwd, iconSetsOf, scopeStorage } from './host'
import { causeSummary, describeCause } from './island-cause'
import { commentLint, islandComment, islandPin, markerMismatch } from './island-marker'
import { applyLints, templateLints } from './lints'
import { SourceMap } from './mapping'
import { parseExpanded } from './markdown-block'
import { signalKind } from './module-signals'
import { SELF } from './names'
import { patternNames } from './pattern-names'
import { findRewrites } from './rewrite'
import { scopeAttribute } from './scoped-style'
import { analyzeScript, analyzeServer } from './script'
import { outerReads, templateReads, templateWords } from './template-reads'
import { ISLAND_TWIN } from './twin'
import { unownedEffects } from './unowned-effects'
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
  // The type of each `_guard.ts` default export above this page or layout, outermost first, which its `ctx.guard` includes.
  outerGuards?: string[] | undefined
  // The named slots the layouts above this page or layout declare, which its `@name` blocks fill: type checking reports a block naming none.
  outerSlots?: string[] | undefined
  // The scope attribute of the component a nested compile belongs to, which its elements carry for that component's styles.
  scope?: string | undefined
  // Output for type checking: adds the link, form field and island prop assertions.
  check?: boolean | undefined
  relocateImport?: ((specifier: string) => string | undefined) | undefined
  // The specifier of the `context` module of the package this file belongs to, which types its `ctx` besides the app's extensions: a library component reads its own extension's keys whether or not the app calls it.
  contextModule?: string | undefined
  // What `src/ui.ts` sets for this component, merged into the classes of its parts: server and browser output only.
  ui?: UiEntry | undefined
  // Code to run: `html` builds server markup as strings, `dom` builds the browser's DOM; type-checking output when unset.
  output?: 'html' | 'dom' | undefined
  // Server output of a build that hydrates: islands carry markers, and a static component renders through its hydratable `?island` twin inside one.
  hydratable?: boolean | undefined
  // The project refreshes page loads by name, so a page marks the elements a refresh may leave to the page as they are.
  namedRefresh?: boolean | undefined
  // Server output of a static component's `?island` twin, which carries markers like an island.
  twinBuild?: boolean | undefined
  // Whether the file is a page of a routes directory, which nothing renders inside an island, so a page without a server fence reads its loops as static as the build does; `false` says it is a component, where a root `@block` is refused.
  page?: boolean | undefined
  // Whether the file is known to be a component, which has no `--- server` fence: a library checked on its own has pages no routes directory names, so only a caller knowing its routes says so.
  component?: boolean | undefined
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
  // The generated offsets where a line of a fence's body starts, which sits one level deeper in the code than in the file.
  bodyLines: number[]
  // Those of the statements copied to the module level.
  moduleLines: number[]
  // Set when the component is interactive and renders as an island.
  island?: string | undefined
  // Set when the static component renders as an island should it pass one what only an island sends.
  promote?: string | undefined
  // What makes the component an island, or what may make it one when `promote` is set: its kind, name and span in the file.
  cause?: IslandCause | undefined
  /** @deprecated Read `cause`: `why`, the sentence of it as `onClick, line 4`, goes with the last slice of #2808. */
  why?: string | undefined
  // The `.class` shorthand names, which CSS tools scanning for class names cannot read off `div.md:flex.w-1/2`.
  classes: string[]
  // Set when the template renders a form posting to an action, which a page holding no island posts through the navigation-only entry.
  actionForm: boolean
  diagnostics: Diagnostic[]
}

const WORD = /[a-z0-9]+/gi
const LEADING_DIGIT = /^\d/
const KAY_EXTENSION = /\.kay$/
const ACTIONS_FILE = '_actions.kay'
const ERROR_PAGE = '_error.kay'
const CARD_PAGE = '_card.kay'
const LAYOUT = '_layout.kay'

// Rendered by the server around or instead of a page, never inside an island.
export const ROUTE_FILES = new Set([LAYOUT, '_404.kay', ERROR_PAGE, CARD_PAGE])
const BACKSLASH = /\\/g
// An icon of an installed set, `~icons/tabler/home`, which the template may draw as a tag.
const ICON_IMPORT = /^~icons\//

// What the installed icon sets add to the key of a cached compile: the promotion of a component depends on them.
export function iconSetsKey(source: string, root: string): string {
  return [...iconSetsOf(source, root) ?? []].toSorted().join(',')
}

// The live values a script imports, which make its component an island: the server changes them and the page follows.
function liveBindings(script: ScriptAnalysis, imported: ImportedSignals | undefined): ScriptAnalysis['imports'] {
  return script.imports.filter(binding => !binding.typeOnly && imported?.[binding.source]?.[binding.imported] === 'live')
}

// The live value an island imports, at its import.
function liveCause(file: KayFile, script: ScriptAnalysis, live: string | undefined): IslandCause | undefined {
  const binding = script.imports.find(binding => binding.local === live)

  return live === undefined || binding === undefined ? undefined : { kind: 'live', name: live, span: binding.span, line: lineOf(file.source, binding.span.start) }
}

// A cause found in the expanded source, in the file: its span, and its line counted in what the author wrote.
function realCause(cause: IslandCause | undefined, expansion: Expansion | undefined, original: string): IslandCause | undefined {
  if (cause === undefined || expansion === undefined)
    return cause

  const span = expansion.realSpan(cause.span)

  return { ...cause, span, line: lineOf(original, span.start) }
}

// A component pinned static that something makes an island: the error stands at that thing, so the author sees it.
function staticPin(comment: boolean, span: Span, cause: IslandCause, island = true): Diagnostic {
  const written = comment ? '`// kay-static`' : '`--- static`'

  return {
    ...span,
    code: 'static-pin',
    message: `This component is pinned ${written}, and ${island ? 'is an island' : 'passes an island what cannot be sent as data'}: ${describeCause(cause)}`,
    note: island ? 'it needs the browser, so it hydrates there' : 'an island is sent its props as data, so the render would throw an `IslandPropsError` on the first request',
    help: 'take that out of the component, or pin it `--- island`',
  }
}

function liveImport(script: ScriptAnalysis, imported: ImportedSignals | undefined): string | undefined {
  return liveBindings(script, imported)[0]?.local
}

// What the server fence declares for the template: its data and its exports, which the script reads as declared rather than as kay values to import.
function serverNames(server: ServerAnalysis | undefined): string[] | undefined {
  return server && [...server.data.map(data => data.name), ...server.exportNames]
}

// What a component's script and template say of its role in the browser, from one analysis.
interface Role {
  // A `--- client` component or an interactive one, an island whatever its file.
  always: boolean
  // A `--- island` fence: an island unless the file is a route file.
  pinned: boolean
  // It imports a live value, which makes a component that is not a route file an island.
  live: boolean
  // A static component that may be promoted to an island by what it passes.
  promotable: boolean
  server: boolean
}

const roles = scopeStorage<Map<string, Map<string, Role>>>()

// Runs a check, in which a component's role is analysed once whoever asks for it, `rendersAsIsland` and `browserRole` alike, kept by the text it was read from.
// Outside one every call analyses again, as the language server and a server compiling on a request need.
export async function inAnalysisScope<T>(run: () => Promise<T>): Promise<T> {
  return roles.getStore() ? run() : roles.run(new Map(), run)
}

function roleOf(original: string, imported: ImportedSignals | undefined, root: string | undefined): Role {
  const kept = roles.getStore()
  const key = JSON.stringify([root, imported])
  const known = kept?.get(original)?.get(key)

  if (known)
    return known

  const { file } = parseExpanded(original)
  const source = file.source
  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, serverNames(server), templateReads(file), file.module, iconSetsOf(source, root), imported)
  const always = file.client !== undefined || isInteractive(file, script)
  const pinned = file.pin?.kind === 'island'
  const role = { always, pinned, live: liveImport(script, imported) !== undefined, promotable: !always && !pinned && islandPin(file)?.kind !== 'static' && promotionSite(file, script, imported) !== undefined, server: file.server !== undefined }

  if (kept) {
    const inner = kept.get(original) ?? new Map<string, Role>()

    kept.set(original, inner)
    inner.set(key, role)
  }

  return role
}

// Whether a component renders as an island of its own, as compileKay decides it, without generating its code.
export function rendersAsIsland(original: string, imported?: ImportedSignals, root?: string): boolean {
  const { always, live, pinned, server } = roleOf(original, imported, root)

  return always || (!server && (live || pinned))
}

// Whether a component is an island, as `compileKay` decides it, or a static component that may be promoted to one by what it passes, which the build does only when its imports reach an island.
// A file with a server fence, a layout and a special page are islands only by their own handlers or `client`, never by a package's live value, and never promoted.
export function browserRole(original: string, filename: string, imported?: ImportedSignals, root?: string): 'island' | 'promotable' | undefined {
  const { always, live, pinned, promotable, server } = roleOf(original, imported, root)
  const routeFile = server || ROUTE_FILES.has(basename(filename))

  if (always || (!routeFile && (live || pinned)))
    return 'island'

  return routeFile || !promotable ? undefined : 'promotable'
}

// The fences of the script and of the module that the browser reads.
function scriptFences(script: ScriptAnalysis): ParsedFence[] {
  return [script.fence, script.moduleFence].filter(fence => fence !== undefined)
}

// The server-only imports in the script of a component the build promotes to an island, which only the project knows: compiling it alone cannot tell whether it is.
export function promotedChecks(original: string, root?: string, imported?: ImportedSignals): Diagnostic[] {
  const { file } = parseExpanded(original)
  const source = file.source
  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, serverNames(server), templateReads(file), file.module, iconSetsOf(source, root), imported)

  return scriptFences(script).flatMap(fence => serverOnlyImports(fence))
}

// The props of a component's script read once into a value a function or the template reads later, for a component the browser runs that compiling it alone cannot tell is one: the project knows which.
export function onceReadChecks(original: string, root?: string, imported?: ImportedSignals): Diagnostic[] {
  const { file } = parseExpanded(original)
  const source = file.source
  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, serverNames(server), templateReads(file), file.module, iconSetsOf(source, root), imported)

  return script.fence ? onceReadProps(script.fence, script.props, templateWords(file)) : []
}

const FAILED_FUNCTION = /^function KayFailed\(/m

// Compiles a .kay component: to TSX the type checker reads, or with `output` to the HTML strings and DOM code that run.
export function compileKay(original: string, filename: string, options: CompileOptions = {}): CompileResult {
  const { file, expansion, problems } = parseExpanded(original)
  const source = file.source
  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, serverNames(server), templateReads(file), file.module, iconSetsOf(source, options.root), options.importedSignals)

  const scope = file.style ? scopeAttribute(islandId(filename, options.root)) : options.scope

  if (scope !== undefined)
    scopeElements(file, scope)

  drawIcons(file, new Set([...script.imports, ...server?.imports ?? []].filter(binding => !binding.typeOnly && binding.imported === 'default' && ICON_IMPORT.test(binding.source)).map(binding => binding.local)))

  // Pages, layouts and special pages render on the server: a package they import never switches them.
  const routeFile = file.server !== undefined || ROUTE_FILES.has(basename(filename))
  const client = file.client !== undefined || (options.clientOnly === true && !routeFile)
  const fallback = client ? takeBlock(file, filename, options, script, scope) : undefined
  // A component's own `@failed`, for a use deferring it as a server island: its function joins this module, the helpers and imports it needs being this module's.
  const failed = !client && !routeFile && options.page !== true ? takeBlock(file, filename, options, script, scope, 'failed') : undefined
  const failedAt = failed?.code.search(FAILED_FUNCTION) ?? -1
  const failedCode = failed && options.output === 'html' && failedAt >= 0 ? failed.code.slice(failedAt) : undefined
  const live = routeFile ? undefined : liveImport(script, options.importedSignals)
  const pinned = file.pin?.kind === 'island' && !routeFile
  const island = client || pinned || isInteractive(file, script) || live !== undefined ? islandId(filename, options.root) : undefined
  const hydratableServer = options.output === 'html' && options.hydratable === true
  const twin = hydratableServer && !options.twinBuild && island === undefined && !routeFile ? `./${basename(filename)}${ISLAND_TWIN}` : undefined
  const comment = islandComment(file)
  const pin = islandPin(file, comment)
  // A component pinned static is never promoted: what it passes an island that cannot be sent is an `island-prop` error.
  const promotion = island === undefined && !routeFile && pin?.kind !== 'static' ? promotionSite(file, script, options.importedSignals) : undefined
  const promote = promotion === undefined ? undefined : islandId(filename, options.root)
  // The build has no types, so it stops at what it knows is not data; `kay check` has the types, and says `island-prop` for the rest.
  const staticPassing = pin?.kind === 'static' && island === undefined && !routeFile && options.check !== true ? promotionSite(file, script, options.importedSignals, true) : undefined
  const rawCause = island === undefined ? promotion : islandCause(file, script) ?? liveCause(file, script, live)
  const cause = realCause(rawCause, expansion, original)
  const generateOptions = { cause: options.inspect === true && cause !== undefined ? causeSummary(cause, island === undefined) : undefined, classTable: options.classTable, classMerge: options.classMerge, island, client, lives: island === undefined ? undefined : liveBindings(script, options.importedSignals).map(binding => binding.local), twin, promote, output: options.output, failedCode, hydratable: hydratableServer && (island !== undefined || options.twinBuild === true), moduleId: islandId(filename, options.root), includeServer: options.includeServer, params: options.params, paramTypes: options.paramTypes, outerQueries: options.outerQueries, outerGuards: options.outerGuards, outerSlots: options.outerSlots, layoutFile: basename(filename) === LAYOUT, component: options.page === false && !routeFile, check: options.check, route: options.check === true && (routeFile || options.page === true), pageFile: routeFile || options.page === true, namedRefresh: options.namedRefresh, insideIsland: options.insideIsland, inspect: options.inspect, inspectSource: expansion ? { text: original, real: (offset: number) => expansion.real(offset) } : undefined, relocateImport: options.relocateImport, contextModule: options.check === true ? options.contextModule : undefined, ui: options.output === undefined ? undefined : options.ui, uiAdded: options.output === undefined ? options.ui : undefined, errorPage: basename(filename) === ERROR_PAGE, cardPage: basename(filename) === CARD_PAGE, special: basename(filename).startsWith('_') && basename(filename) !== LAYOUT }
  // The analysis pass names the component so no read resolves to it, then the name is chosen free of what the code reads.
  const analysis = generate(file, script, server, { ...generateOptions, name: SELF })
  const imported = new Map<string, SignalKind>([...script.imports, ...server?.imports ?? []].flatMap((binding) => {
    const kind = binding.typeOnly ? undefined : signalKind(options.importedSignals?.[binding.source]?.[binding.imported])

    return kind ? [[binding.local, kind] as const] : []
  }))
  // Only code that runs calls the accessors of rows and aliases; the type checker reads them as values, which it narrows.
  const values = options.output === undefined
  const found = findRewrites({ code: analysis.builder.code, map: analysis.builder.map(), sites: analysis.sites, values, templateStart: file.templateStart, imported, component: componentName(filename), check: options.check, fixedPage: routeFile })
  const fences = [file.script, file.server, file.module].map(span => span ? source.slice(span.start, span.end) : '').join('\n')
  const name = freeName(componentName(filename), fences, found.findings.globalReads)
  const final = generate(file, script, server, { ...generateOptions, name, rewrites: found.plan.rewrites, translates: found.plan.translates, writes: found.plan.writes, values: found.plan.values })
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
    ...coded(pin?.kind === 'static' && cause !== undefined && rawCause !== undefined && !routeFile && island !== undefined ? [staticPin(pin.comment, rawCause.span, cause)] : [], 'static-pin'),
    ...coded(staticPassing ? [staticPin(pin?.comment === true, staticPassing.span, staticPassing, false)] : [], 'static-pin'),
  ]

  // Code that does not parse usually already has a better diagnostic from the fence or the template; this one is what is left when nothing else explains it.
  if (found.syntaxError && diagnostics.length === 0)
    diagnostics.push(...coded([found.syntaxError], 'fence-syntax'))

  const checked = options.check === true && options.typesOnly !== true

  // Type checking only, so a page still runs while it is fixed, and fails there in development naming the same fixes.
  const serverData = server?.data.map(data => data.name) ?? []

  if (checked && !client)
    diagnostics.push(...coded(browserReads(file, island !== undefined, serverData, routeFile), 'browser-only-read'))

  if (checked)
    diagnostics.push(...coded(unownedEffects(file, serverData), 'template-invalid'))

  // Code that did not compile may have taken reads and writes with it, so a file with an error is not searched for unread names or unwritten signals.
  const broken = diagnostics.some(diagnostic => !diagnostic.checkOnly)

  if (checked) {
    const fenceLints = [script.fence, script.moduleFence, server?.fence].flatMap(fence => fence ? [...cssImportsWithoutText(fence), ...asyncReplies(fence), ...openRedirects(fence), ...missingCaptchas(fence), ...unreturnedFails(fence)] : [])
    // The script runs in the browser as an island's and in a component only islands render; a static one that may be promoted to an island is read by the project check, which knows whether the build promotes it.
    const browserScript = (island !== undefined || options.insideIsland === true) && !routeFile ? scriptFences(script) : []
    const unusedLints = broken ? [] : [...unreadNames(source, file.template, script, server, found.findings), ...constantSignals(source, [file.script, file.module], found.findings)]

    diagnostics.push(...unboundedFields(server), ...fenceLints, ...browserScript.flatMap(fence => serverOnlyImports(fence)), ...browserScript.includes(script.fence!) ? onceReadProps(script.fence!, script.props, templateWords(file)) : [], ...unusedLints, ...templateLints(file))
  }

  if (checked && pin !== undefined)
    diagnostics.push(...markerMismatch(pin, routeFile))

  if (checked && comment !== undefined)
    diagnostics.push(commentLint(file, comment))

  if (file.client && file.module)
    diagnostics.push({ ...file.client, code: 'fence-invalid', message: 'A `--- client` component has no `--- module` fence', note: 'the server loads only its live imports, so its exports would be missing there', help: 'put the shared values in a `.ts` module' })

  if (file.server && options.component === true && !basename(filename).startsWith('_')) {
    diagnostics.push({ ...file.serverFence!, code: 'fence-invalid', message: 'A component has no `--- server` fence', note: 'only a page or a layout runs on the server for each request, and a component would take its values as required props', help: 'compute the value in the page or layout and pass it as a prop, or read it in an action' })
  }

  if (file.client && routeFile)
    diagnostics.push({ ...file.client, code: 'client-route-fence', message: 'A page, layout or special page cannot be `--- client`', note: 'it renders on the server', help: 'move what needs the browser to a component it renders, and make that one `--- client`' })

  const shorthands = diagnostics.some(diagnostic => (diagnostic.fixes?.length ?? 0) > 0) ? [...elementsIn(file.template)].flatMap(element => element.attributes.filter((attribute): attribute is Shorthand => attribute.kind === 'expression' && attribute.shorthand !== undefined)) : []
  const facts = templateFacts(file)
  const classes = [...facts.classes, ...expansion?.classes(file) ?? [], ...fallback?.classes ?? [], ...failed?.classes ?? []]
  const spelled = (options.check ? applyLints(diagnostics, source, options.lints) : diagnostics).map(diagnostic => spelledOut(diagnostic, shorthands, source))
  const reported = (expansion ? [...spelled.map(diagnostic => expansion.diagnostic(diagnostic)), ...coded(problems, 'template-syntax')] : spelled).sort((a, b) => a.start - b.start)

  // The server never renders a client-only island, so its module leaves the script out: a package touching `window` as it loads never loads there.
  if (client && options.output === 'html' && island !== undefined) {
    // Only the live values it imports stay, so the page it renders in proves them.
    const lives = liveBindings(script, options.importedSignals)
    const imports = lives.map(binding => `import { ${binding.imported} as ${binding.local} } from ${JSON.stringify(binding.source)}\n`).join('')

    return { tsx: `import { island as KayIsland } from 'kay/island'\n${imports}${fallback?.code ?? ''}\nexport default KayIsland(${JSON.stringify(island)}, undefined${islandMessages(source, true, lives.map(binding => binding.local), undefined, fallback !== undefined)})\n`, map: new SourceMap([], []), bodyLines: [], moduleLines: [], island, cause, why: cause && describeCause(cause), classes, actionForm: facts.actionForm, diagnostics: reported }
  }

  return {
    tsx: final.builder.code,
    map: expansion ? final.builder.map().expanded(expansion) : final.builder.map(),
    bodyLines: final.builder.bodyLines,
    moduleLines: final.builder.moduleLines,
    island,
    promote,
    cause,
    why: cause && describeCause(cause),
    classes,
    actionForm: facts.actionForm,
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

const FALLBACK_COMPONENT = /^export default function \w+\(/m

// The `@fallback` block at the root of a client-only component, which the server shows where the island will render, or the `@failed` block of a component a use defers as a server island: taken out of the template, and compiled alone, as the server never runs the script it would read.
// It keeps the script's imports it names and the component's scope attribute, and reports a script value or prop it reads, which the server does not have.
function takeBlock(file: KayFile, filename: string, options: CompileOptions, script: ScriptAnalysis, scope: string | undefined, which: 'fallback' | 'failed' = 'fallback'): { code: string, classes: string[] } | undefined {
  const index = file.template.findIndex(node => node.kind === 'slot' && file.source.slice(node.name.start, node.name.end) === which)
  const block = file.template[index]

  if (block?.kind !== 'slot')
    return undefined

  file.template.splice(index, 1)

  let lineStart = block.start
  const written = file.source.slice(block.start, block.end).split('\n').map((text) => {
    const line = { text, start: lineStart }

    lineStart += text.length + 1

    return line
  }).slice(1).filter(line => line.text.trim() !== '')
  const lines = written.map(line => line.text)
  const indent = lines.length === 0 ? 0 : Math.min(...lines.map(line => line.length - line.trimStart().length))
  const body = lines.map(line => line.slice(indent)).join('\n')
  const named = (name: string) => new RegExp(`(?<![\\w$])${name.replaceAll('$', '\\$')}(?![\\w$])`).test(body)
  const imports = script.imports.filter(binding => !binding.typeOnly && named(binding.local)).map(binding => file.source.slice(binding.declaration.start, binding.declaration.end))
  const header = imports.length === 0 ? '' : `---\n${[...new Set(imports)].join('\n')}\n---\n`
  const compiled = compileKay(header + body, filename, { output: 'html', root: options.root, component: true, scope })
  const own = new Set(script.imports.map(binding => binding.local))
  const declared = new Set([...script.props?.bindings.map(binding => file.source.slice(binding.local.start, binding.local.end)) ?? [], ...scriptNames(script)])
  const parsed = parseExpanded(header + body).file
  const reads = outerReads(parsed).filter(name => declared.has(name) && !own.has(name))

  // A server island in the block is refused below, at the island itself.
  for (const diagnostic of compiled.diagnostics.filter(diagnostic => which !== 'failed' || diagnostic.message !== SERVER_IN_ISLAND))
    file.diagnostics.push({ ...diagnostic, start: block.name.start, end: block.name.end })

  // The block is spliced into the page hidden and hydrates nothing, so what needs the browser or a request of its own has no place in it.
  if (which === 'failed') {
    // A span of the block as compiled alone, at the same place in the file.
    const placed = (span: Span): Span => {
      const at = span.start - header.length
      const line = written[body.slice(0, Math.max(at, 0)).split('\n').length - 1]

      if (at < 0 || line === undefined)
        return block.name

      const start = line.start + indent + at - (body.lastIndexOf('\n', at - 1) + 1)

      return { start, end: start + span.end - span.start }
    }

    // Where the refusal points: the node found in the block, else the block's name.
    const refused = (span: Span | undefined, message: string, help: string) => file.diagnostics.push({ ...span === undefined ? block.name : placed(span), code: 'template-invalid', message, note: 'the block is rendered hidden with the server island, and nothing in it hydrates', help })
    let island: Span | undefined
    let handler: Span | undefined
    let action: Span | undefined

    visitNodes(parsed.template, (node) => {
      if (node.kind !== 'element')
        return

      island ??= serverIslandOf(node, parsed.source) === undefined ? undefined : node.tag
      handler ??= node.attributes.flatMap(attribute => attribute.kind !== 'spread' && INTERACTIVE_ATTRIBUTE.test(parsed.source.slice(attribute.name.start, attribute.name.end)) ? [attribute.name] : [])[0]
      action ??= actionOf(node, parsed.source) ? node.tag : undefined
    })

    if (island)
      refused(island, '`@failed` holds a server island', 'render it outside the block, or leave it out')
    else if (compiled.island !== undefined)
      refused(handler, '`@failed` holds something interactive', 'keep static markup and links, and a control marked `data-kay-retry`')

    if (compiled.actionForm)
      refused(action, '`@failed` holds a form posting to an action', 'link to the page holding the form instead')
  }

  for (const name of reads) {
    const at = file.source.slice(block.start, block.end).search(new RegExp(`(?<![\\w$])${name.replaceAll('$', '\\$')}(?![\\w$])`, 'g'))
    const start = at < 0 ? block.name.start : block.start + at

    file.diagnostics.push({ start, end: at < 0 ? block.name.end : start + name.length, code: 'template-invalid', message: `\`@${which}\` of ${which === 'failed' ? 'a' : 'a `--- client`'} component reads \`${name}\`, which the server does not have`, note: 'the server renders it without running the script', help: 'write static markup, or import what it needs' })
  }

  return { code: compiled.tsx.replace(FALLBACK_COMPONENT, which === 'failed' ? 'function KayFailed(' : 'function KayFallback('), classes: compiled.classes }
}

// The top-level names a script declares, which a fallback reading one reads a value the server does not have.
function scriptNames(script: ScriptAnalysis): string[] {
  return (script.fence?.ast.body ?? []).flatMap((statement) => {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type === 'VariableDeclaration')
      return declaration.declarations.flatMap(declarator => patternNames(declarator.id))

    if (declaration?.type === 'TSEnumDeclaration')
      return [declaration.id.name]

    return (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') && declaration.id ? [declaration.id.name] : []
  })
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

// The signals the component script and the module fence declare and nothing writes.
function constantSignals(source: string, fences: (Span | undefined)[], found: NameFindings): Diagnostic[] {
  return found.constantSignals.filter(({ name }) => fences.some(fence => fence !== undefined && name.start >= fence.start && name.end <= fence.end)).map(({ name, value }) => {
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

// A component with a `--- style` fence marks every element it writes, which the fence's selectors end on; a component's root is the caller's to reach through `class`.
function scopeElements(file: KayFile, attribute: string): void {
  for (const element of elementsIn(file.template)) {
    if (!element.component && element.outlet === undefined)
      element.fixed = `${element.fixed ?? ''} ${attribute}`
  }
}

export function islandId(filename: string, root = cwd()): string {
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
