import type { ConstNode, ElementNode, KayFile, Node, Span, TemplateFacts, TemplateHelper } from './ast'
import type { Rewrite } from './mapping'
import type { PageSettingName } from './page-settings'
import type { ImportBinding, ScriptAnalysis, ServerAnalysis } from './script'
import { actionUrl } from '../runtime/action'
import { errorMessages, isHead, someNode, templateFacts } from './ast'
import { domHelperImport, DomTemplate } from './dom'
import { mayHoldFunction } from './expression'
import { htmlHelperImport, HtmlTemplate } from './html'
import { sourceLocator } from './inspect'
import { constDeclaration } from './items'
import { JsxTemplate } from './jsx'
import { CodeBuilder, DYNAMIC_TAG } from './mapping'
import { helperName } from './markup'
import { PAGE, PAGE_SETTINGS } from './page-settings'
import { headTagProblem, sharedImports } from './validate'

export interface GenerateOptions {
  name: string
  // The component reads `t` unimported: the translation function from `kay/i18n`, imported here.
  translates?: boolean | undefined
  // Set for an interactive component: its export is wrapped so the server renders it as an island root.
  island?: string | undefined
  // The island renders in the browser only: `--- client`, or a package it imports cannot load on the server.
  client?: boolean | undefined
  // Path relative to the project root, naming the module's actions.
  moduleId: string
  // Development: every element carries its source position, for `kay dev`'s inspector.
  inspect?: boolean | undefined
  // Type-checking output: adds assertions on links, form fields and island props through globals `kay check` declares.
  check?: boolean | undefined
  // Type-checking a static component only islands render: the props it passes its children are not serialized, so they are not asserted.
  insideIsland?: boolean | undefined
  // Browser builds leave the `--- server` fence out entirely; type checking and SSR keep it.
  includeServer?: boolean | undefined
  // Route parameters, typing `ctx.params` in `load`.
  params?: string[] | undefined
  paramTypes?: Record<string, string> | undefined
  // `_error.kay`, whose `ctx` carries the error it renders.
  errorPage?: boolean | undefined
  // A layout or special page, which reads the query its page declares rather than one of its own.
  special?: boolean | undefined
  // Server output without hydration markers for a static component: inside an island it renders through this hydratable build of itself instead.
  twin?: string | undefined
  // Set for a static component that may pass an island what only an island sends: the id it renders as an island by when it does.
  promote?: string | undefined
  // Code to run rather than type-check, built from the template: `html` builds server markup as strings, `dom` builds the browser's DOM. The analysis pass still generates JSX, which scope analysis reads.
  output?: 'html' | 'dom' | undefined
  // Server markup of an island or a twin, carrying the markers hydration needs.
  hydratable?: boolean | undefined
  // Points a relative import elsewhere, or keeps it when it returns undefined: a shadow file sits deeper than its source.
  relocateImport?: ((specifier: string) => string | undefined) | undefined
  // Final pass: rewrites from the analysis pass are applied and the props destructuring disappears.
  rewrites?: ReadonlyMap<number, Rewrite & { end: number }> | undefined
}

export interface Generated {
  builder: CodeBuilder
  // Generated offsets of parameters whose references must be called: loop items, loop indexes, narrowed `if` aliases.
  accessorSites: Set<number>
  // Generated offsets of the names a template `const` declares, its pattern's start.
  constSites: Set<number>
}

const CTX_REFERENCE = /\bctx\b/
const IMPORT_COMMA_AFTER = /^\s*,\s*/
const IMPORT_COMMA_BEFORE = /,\s*$/
const DEFAULT_PREFIX = '__default_'
// `kay build` renders the page once when it is `true`.
const PRERENDER: PageSettingName = 'prerender'
// The page's query schema, which types and validates `ctx.query`.
const QUERY: PageSettingName = 'query'
// `t('nav.home')` or `T(key="intro")`: a message key an island's source names as it is written.
const MESSAGE_KEY = /(?:\bt\(\s*|\bT\([^)]*?\bkey=)(['"`])([\w.-]+)\1/g
// The server exports that are no actions: the page's settings, and each under its own name as they were exported before.
const NOT_ACTIONS = new Set<string>([PAGE, ...PAGE_SETTINGS])
// A type parameter's name, past the `const`, `in` and `out` modifiers it may carry.
const TYPE_PARAMETER_NAME = /^\s*(?:(?:const|in|out)\s+)*([A-Z_$][\w$]*)/i

export function defaultName(index: number): string {
  return `${DEFAULT_PREFIX}${index}`
}

// What a pass builds: JSX, which the analysis pass reads, the same JSX with `kay check`'s assertions, or the code that runs, markup strings on the server or the browser's DOM.
export type OutputMode = 'jsx' | 'check' | 'html' | 'dom'

// Where a component stands toward islands: an island root; a static component rendering through its hydratable twin inside one, which may also render as an island itself where it must (`promotable twin`, or `promotable` without a twin); a static component only islands render; or a plain one.
export type IslandKind = 'island' | 'twin' | 'promotable twin' | 'promotable' | 'inside island' | 'static'

export function outputMode(options: GenerateOptions): OutputMode {
  // Only the final pass builds what runs.
  if (options.rewrites && options.output !== undefined)
    return options.output

  return options.check ? 'check' : 'jsx'
}

export function islandKind(options: GenerateOptions): IslandKind {
  if (options.island !== undefined)
    return 'island'

  if (options.twin !== undefined)
    return options.promote === undefined ? 'twin' : 'promotable twin'

  if (options.insideIsland)
    return 'inside island'

  return options.promote === undefined ? 'static' : 'promotable'
}

export function generate(file: KayFile, script: ScriptAnalysis, server: ServerAnalysis | undefined, options: GenerateOptions): Generated {
  return new ModuleShell(file, script, server, options).run()
}

// The module around a template, alike for every output mode: its imports, the server fence's `load`, the component's signature, props and script, and its export; the template renders through the writer of the mode.
class ModuleShell {
  private readonly b: CodeBuilder
  private readonly accessorSites = new Set<number>()
  private readonly constSites = new Set<number>()
  private readonly src: string
  private readonly mode: OutputMode
  private readonly kind: IslandKind
  // The `--- server` fence, unless this output leaves it out, as a browser build does.
  private readonly fence: ServerAnalysis | undefined
  private readonly facts: TemplateFacts
  // Server values an `await` block renders by name: `load` defers each where it is declared, so the template changes how the server fence runs.
  private readonly deferred: Set<string>
  private readonly jsx: JsxTemplate

  constructor(private readonly file: KayFile, private readonly script: ScriptAnalysis, private readonly server: ServerAnalysis | undefined, private readonly options: GenerateOptions) {
    this.src = file.source
    this.b = new CodeBuilder(file.source, options.rewrites)
    this.mode = outputMode(options)
    this.kind = islandKind(options)
    this.fence = options.includeServer === false ? undefined : server
    this.facts = templateFacts(file)
    this.deferred = deferredData(this.facts, this.fence)
    this.jsx = new JsxTemplate(this.b, this.src, this.facts, {
      check: this.mode === 'check',
      staticLoops: this.staticLoops,
      sendsIslandProps: this.kind === 'static' || this.kind === 'twin',
      identityKeys: this.kind === 'island' || this.kind === 'inside island',
    }, this.accessorSites, this.constSites)
  }

  run(): Generated {
    const { head, hoisted, template } = this.splitHead(this.file.template)

    this.imports(head !== undefined)

    if (this.fence)
      this.emitLoad(this.fence)

    this.signature()
    this.emitBody()

    for (const node of hoisted)
      this.emitHoistedConst(node)

    // An island sets no head, and a static component rendering inside one leaves it to the server.
    if (head && this.mode !== 'dom')
      this.emitHead(head)

    this.b.add('\nreturn ')
    this.template(template)
    this.exports()

    return { builder: this.b, accessorSites: this.accessorSites, constSites: this.constSites }
  }

  private imports(head: boolean): void {
    const { b, script, server, fence, facts, mode } = this
    // What the fences use from `kay` unimported, as they use `props<T>()`; a name the other fence of the same module imports needs no import.
    const imported = new Set([...script.imports, ...fence?.imports ?? []].map(binding => binding.local))
    const implicit = [...script.implicit, ...fence?.implicit ?? []].filter(name => !imported.has(name))

    if (implicit.length > 0)
      b.add(`import { ${[...new Set(implicit)].join(', ')} } from 'kay'\n`)

    if (this.options.translates === true && !imported.has('t'))
      b.add('import { t } from \'kay/i18n\'\n')

    for (const span of script.hoisted)
      this.emitHoisted(span, script.specifiers, script.imports, [])

    if (fence) {
      const { duplicates } = sharedImports(script, fence)

      for (const span of fence.hoisted)
        this.emitHoisted(span, fence.specifiers, fence.imports, duplicates)
    }

    if (server)
      b.add(`import type { ${this.options.errorPage ? 'ErrorPageContext' : 'PageContext'} as KayPageContext, PageData as KayPageData${this.declaresQuery() !== undefined ? ', QueryOf as KayQueryOf' : ''}${this.settingType(PRERENDER) !== undefined ? ', PrerenderedContext as KayPrerenderedContext' : ''}${mode === 'check' && server.page ? ', PageSettings as KayPageSettings' : ''} } from 'kay'\n`)

    const kayHelpers: KayHelper[] = facts.actionForm ? ['formAction'] : []
    const actions = server?.exportNames.filter(name => !NOT_ACTIONS.has(name)) ?? []
    const runs = this.runs
    const used: Helper[] = [...script.props?.rest ? ['omit' as const] : [], ...facts.helpers]

    if (this.deferred.size > 0)
      kayHelpers.push('autoDefer')

    // What fills a form's fields back in once a post was refused.
    if (runs && facts.actionForm)
      kayHelpers.push('formValue', 'formChecked', 'formInvalid', 'formError')

    if (mode === 'html' && facts.actionForm)
      kayHelpers.push('formProtection')

    if (fence ? fence.exportNames.length > 0 : actions.length > 0)
      kayHelpers.push(fence ? 'registerActions' : 'actionStub')

    if (kayHelpers.length > 0)
      b.add(`import { ${kayHelpers.map(helper => `${helper} as ${helperName(helper)}`).join(', ')} } from 'kay/internal'\n`)

    if (server && !fence) {
      for (const name of actions)
        b.add(`export const ${name} = KayActionStub(${JSON.stringify(actionUrl(this.options.moduleId, name))})\n`)
    }

    if (facts.childrenSlot)
      b.add(`import type { JSX as KayJSX } from 'kay'\n`)

    if (mode === 'html')
      b.add(htmlHelperImport())

    if (mode === 'dom')
      b.add(domHelperImport())

    // Code that only gets read, by the type checker and the analysis pass, declares the helpers of its control flow rather than import a runtime of them.
    const declared: [name: string, helper: DeclaredHelper][] = runs ? [] : used.filter(helper => helper !== 'For').map(helper => [helperName(helper), helper])

    if (used.includes('For') && !runs)
      declared.push(this.staticLoops ? ['KayStaticFor', 'staticFor'] : ['KayLoopFor', 'For'])

    if (this.kind === 'island')
      b.add(`import { island as KayIsland } from 'kay/island'\n`)

    if (this.kind === 'twin' || this.kind === 'promotable twin')
      b.add(`import { ${this.kind === 'twin' ? 'insideIsland as KayInsideIsland' : 'promote as KayPromote'} } from 'kay/island'\nimport KayHydrated from ${JSON.stringify(this.options.twin)}\n`)

    if (this.kind === 'island' && this.genericComponent)
      b.add(`import type { IslandBrand as KayIslandBrand, IslandOptions as KayIslandOptions } from 'kay'\n`)

    if (facts.await && mode !== 'dom')
      b.add(`import { Await as KayAwait } from 'kay/await'\n`)

    if (facts.try && !runs)
      declared.push(['KayTry', 'Try'])

    if (!runs && this.options.rewrites && [...this.options.rewrites.values()].some(rewrite => rewrite.dynamic))
      declared.push([DYNAMIC_TAG, 'Dynamic'])

    if (head && mode === 'jsx')
      declared.push(['KayUseHead', 'head'])

    if (declared.length > 0) {
      b.add(`import type { TemplateHelpers as KayTemplateHelpers } from 'kay'\n`)

      for (const [name, helper] of declared)
        b.add(`declare const ${name}: KayTemplateHelpers[${JSON.stringify(helper)}]\n`)
    }
  }

  // The component function's head: its type parameters and props, read off `__props`.
  private signature(): void {
    const { b, script, server } = this
    const { childrenSlot } = this.facts
    const childrenType = ' & { children?: KayJSX.Element }'

    b.add(`\n${this.wrapped ? '' : 'export default '}function ${this.options.name}`)

    if (this.file.typeParameters && !server)
      b.add('<').addSource(this.file.typeParameters).add('>')

    b.add('(')

    if (server) {
      b.add(`__props: KayPageData<typeof load>${childrenSlot ? childrenType : ''}`)
    }
    else if (script.props) {
      b.add(childrenSlot ? '__props: (' : '__props: ')

      if (script.props.type)
        b.addSource(script.props.type)
      else
        b.add('Record<string, unknown>')

      if (childrenSlot)
        b.add(`)${childrenType}`)
    }
    else if (childrenSlot) {
      b.add('__props: { children?: KayJSX.Element }')
    }
    else if (this.facts.slot) {
      b.add('__props: {}')
    }

    b.add(') {\n')
  }

  // What the component returns, through the writer of the mode, closing its function.
  private template(nodes: Node[]): void {
    const { b, src, mode } = this
    const visible = nodes.filter(node => node.kind !== 'slot')
    const errors = this.runs ? errorMessages(nodes, src) : undefined
    const located = this.options.inspect === true ? sourceLocator(src, this.options.moduleId) : undefined

    if (mode === 'html') {
      new HtmlTemplate(b, src, this.facts, { hydratable: this.options.hydratable, accessorLoops: !this.staticLoops, errors, located }).value(visible)
      b.add('\n}\n')
    }
    else if (mode === 'dom') {
      const dom = new DomTemplate(b, src, this.facts, errors, located)

      dom.block(visible)
      b.add('\n}\n')
      b.add(dom.declarations())
    }
    else {
      this.jsx.emitRoot(nodes)
      b.add('\n}\n')
    }
  }

  // An island, or a static component with a hydratable twin, exports its function wrapped.
  private exports(): void {
    const { b, src } = this
    const { name } = this.options

    if (this.kind === 'promotable twin')
      b.add(`\nexport default KayPromote(${JSON.stringify(this.options.promote)}, ${name} as never, KayHydrated as never${islandMessages(src)}) as typeof ${name}\n`)
    else if (this.kind === 'twin')
      b.add(`\nexport default ((props: never) => KayInsideIsland() ? KayHydrated(props) : ${name}(props)) as typeof ${name}\n`)
    else if (this.kind === 'island')
      b.add(`\nexport default KayIsland(${JSON.stringify(this.options.island)}, ${name}${this.genericComponent ? ' as never' : ''}${islandMessages(src, this.options.client)})${this.genericIslandType()}\n`)
  }

  private get wrapped(): boolean {
    return this.kind === 'island' || this.kind === 'twin' || this.kind === 'promotable twin'
  }

  private get runs(): boolean {
    return this.mode === 'html' || this.mode === 'dom'
  }

  // Pages, layouts and static components outside islands render once on the server and never hydrate, so their loops hand each row its item rather than an accessor to it.
  private get staticLoops(): boolean {
    if (this.mode === 'check' || this.kind === 'island')
      return false

    return this.options.output === 'html' || this.kind === 'twin' || this.kind === 'promotable twin' || this.fence !== undefined
  }

  // The type of the page's query schema, when it declares one; a layout or special page reads its page's.
  private declaresQuery(): string | undefined {
    return this.options.special ? undefined : this.settingType(QUERY)
  }

  // What `load` types a setting from: its key of `page`.
  private settingType(name: PageSettingName): string | undefined {
    return this.server?.page?.settings.has(name) ? `typeof ${PAGE}.${name}` : undefined
  }

  private get genericComponent(): boolean {
    return this.file.typeParameters !== undefined && this.server === undefined
  }

  // `island()` would fix the type parameters to their constraints, so a generic island keeps its own signature, instantiated per use, plus `hydrate` and `persist`.
  private genericIslandType(): string {
    if (!this.genericComponent)
      return ''

    const parameters = this.text(this.file.typeParameters!)
    const { name } = this.options

    return ` as unknown as KayIslandBrand & (<${parameters}>(props: Parameters<typeof ${name}<${typeParameterNames(parameters).join(', ')}>>[0] & KayIslandOptions) => ReturnType<typeof ${name}>)`
  }

  private emitHoisted(span: Span, specifiers: Span[], imports: ImportBinding[], duplicates: ImportBinding[]) {
    const inside = (binding: ImportBinding) => binding.declaration.end === span.end
    const left = duplicates.filter(inside)

    if (left.length > 0 && left.length === imports.filter(inside).length)
      return

    const edits: { start: number, end: number, text?: string }[] = left.map(binding => this.withoutComma(binding.span, binding.declaration))

    for (const specifier of specifiers) {
      const target = specifier.start >= span.start && specifier.end <= span.end ? this.options.relocateImport?.(this.src.slice(specifier.start + 1, specifier.end - 1)) : undefined

      if (target !== undefined)
        edits.push({ ...specifier, text: JSON.stringify(target) })
    }

    let cursor = span.start

    for (const edit of edits.sort((a, b) => a.start - b.start)) {
      this.b.addSource({ start: cursor, end: edit.start })

      if (edit.text !== undefined)
        this.b.add(edit.text)

      cursor = edit.end
    }

    this.b.addSource({ start: cursor, end: span.end }).add('\n')
  }

  // An import specifier with the comma that separates it from its neighbour.
  private withoutComma(specifier: Span, declaration: Span): Span {
    const after = IMPORT_COMMA_AFTER.exec(this.src.slice(specifier.end, declaration.end))

    if (after)
      return { start: specifier.start, end: specifier.end + after[0].length }

    const before = IMPORT_COMMA_BEFORE.exec(this.src.slice(declaration.start, specifier.start))

    return { start: specifier.start - (before?.[0].length ?? 0), end: specifier.end }
  }

  // Server exports stay at module level; the rest of the fence becomes `load(ctx)`, returning every name it declares.
  private emitLoad(server: ServerAnalysis) {
    const { b } = this
    const query = this.declaresQuery()
    // Typed where it is written, so the editor completes its keys and `kay check` reports one kay does not know.
    const page = this.mode === 'check' ? server.page?.init : undefined

    for (const span of server.exports) {
      if (page && page.start >= span.start && page.end <= span.end)
        b.addSource({ start: span.start, end: page.end }).add(' satisfies KayPageSettings').addSource({ start: page.end, end: span.end }).add('\n')
      else
        b.addSource(span).add('\n')

      this.deferDeclared(server, span)
    }

    if (server.exportNames.length > 0)
      b.add(`KayRegisterActions(${JSON.stringify(this.options.moduleId)}, { ${server.exportNames.join(', ')} })\n`)

    const params = this.options.params ? `{ ${this.options.params.map(name => `${JSON.stringify(name)}: ${this.options.paramTypes?.[name] ?? 'string'}`).join(', ')} }` : 'Record<string, string>'

    // An unused parameter would trip `noUnusedParameters` in the user's tsconfig, so it is named `_ctx` when the fence never reads it.
    const ctx = server.body.some(span => CTX_REFERENCE.test(this.text(span))) ? 'ctx' : '_ctx'

    const context = `KayPageContext<${params}${query !== undefined ? `, KayQueryOf<${query}>` : ''}>`
    const prerender = this.settingType(PRERENDER)

    b.add(`\nexport async function load(${ctx}: ${prerender !== undefined ? `KayPrerenderedContext<${prerender}, ${context}>` : context}) {\n`)
    for (const span of server.body) {
      b.addSource(span)

      this.deferDeclared(server, span)
    }
    b.add(`\nreturn { ${server.data.map(data => this.deferred.has(data.name) ? `${data.name}: ${helperName('autoDefer')}(${data.name})` : data.name).join(', ')} }\n}\n`)
  }

  // Right where a deferred value is declared, so a promise rejecting while a later statement awaits crashes nothing; a statement an export reads runs at module level.
  private deferDeclared(server: ServerAnalysis, span: Span) {
    for (const data of server.data) {
      if (this.deferred.has(data.name) && data.local.start >= span.start && data.local.end <= span.end)
        this.b.add(`\n${helperName('autoDefer')}(${data.name})\n`)
    }
  }

  // Script statements in source order, with the props declaration swapped for reads off `__props`.
  private emitBody() {
    const data = this.server?.data ?? []

    if (!this.options.rewrites && data.length > 0) {
      this.b.add('\nconst { ')
      for (const binding of data)
        this.b.add(`${JSON.stringify(binding.name)}: `).addSource(binding.local).add(', ')
      this.b.add('} = __props;\n')
    }

    const props = this.script.props
    let propsDone = !props

    for (const span of this.script.body) {
      if (!propsDone && props!.statement.start < span.start) {
        this.emitProps()
        propsDone = true
      }

      this.b.addSource(span)
    }

    if (!propsDone)
      this.emitProps()
  }

  private emitProps() {
    const { b } = this
    const props = this.script.props!

    b.add('\n')

    if (props.name)
      b.add('const ').addSource(props.name).add(' = __props;\n')

    // A default runs the first time an `undefined` prop is read, then keeps its value like a destructuring default; it is typed as the prop, so a function or an object literal in it gets its type from the props type.
    for (const [index, binding] of props.bindings.entries()) {
      if (!binding.fallback)
        continue

      const name = defaultName(index)
      const type = `Exclude<(typeof __props)[${JSON.stringify(binding.key)}], undefined>`

      b.add(`let ${name}_made: { value: ${type} } | undefined;\n`)
      b.wrap(binding.local, () => b.add(`const ${name} = (): ${type} => (${name}_made ??= { value: (`))
      b.addSource(binding.fallback).add(') }).value;\n')
    }

    if (props.rest)
      b.add('const ').addSource(props.rest).add(` = ${helperName('omit')}(__props, ${props.bindings.map(binding => JSON.stringify(binding.key)).join(', ')});\n`)

    // The analysis pass declares the destructured names so scope analysis can find every read of them; the final pass rewrites those reads instead.
    if (!this.options.rewrites && props.bindings.length > 0) {
      b.add('const { ')
      for (const binding of props.bindings)
        b.add(`${JSON.stringify(binding.key)}: `).addSource(binding.local).add(', ')
      b.add('} = __props;\n')
    }
    // Type checking keeps each `{ title }` as a read of its prop, so the editor hovers, finds and renames it with the prop.
    else if (this.mode === 'check') {
      for (const binding of props.bindings) {
        if (this.text(binding.local) === binding.key)
          b.add('__props.').addSource(binding.local).add(';\n')
      }
    }
  }

  // A top-level `const` before the `head` block, declared ahead of it so the head reads it too.
  private emitHoistedConst(node: ConstNode) {
    const { b } = this
    const memo = this.staticLoops ? undefined : 'KayMemo'

    if (this.runs) {
      b.wrap(node, () => constDeclaration(b, node, this.src, memo))
      b.add('\n')

      return
    }

    b.wrap(node, () => {
      b.add('const ')
      this.constSites.add(b.code.length)

      if (memo !== undefined)
        this.accessorSites.add(b.code.length)

      b.addSource(node.pattern).add(' = (').addSource(node.value).add(');\n')
    })
  }

  // The template's top-level `head` block, which renders into the document head rather than in place, and the `const` lines before it, declared ahead of it.
  private splitHead(nodes: Node[]): { head?: ElementNode | undefined, hoisted: ConstNode[], template: Node[] } {
    let head: ElementNode | undefined
    const template: Node[] = []
    const headAt = nodes.findIndex(isHead)
    const hoisted = nodes.slice(0, Math.max(headAt, 0)).filter(node => node.kind === 'const')

    for (const node of nodes) {
      if (node.kind === 'const' && hoisted.includes(node))
        continue

      if (!isHead(node)) {
        template.push(node)

        continue
      }

      head ??= node
    }

    return { head, hoisted, template }
  }

  // Registered before the template renders, so a page's title and meta tags win over its layouts': they render first and register first.
  private emitHead(head: ElementNode) {
    const { b } = this
    const tags = head.children.filter((child): child is ElementNode => headTagProblem(child) === undefined)

    if (this.mode === 'check') {
      b.add('void (<>')
      this.jsx.emitChildren(tags)
      b.add('</>);\n')

      return
    }

    b.add(this.mode === 'html' ? 'KayHead([' : 'KayUseHead([')
    for (const tag of tags) {
      this.emitHeadTag(tag)
      b.add(', ')
    }
    b.add(']);\n')
  }

  // The tag `head()` takes: `{ tag: 'meta', props: { name: 'description', content: (description) } }`.
  private emitHeadTag(element: ElementNode) {
    const { b } = this

    b.wrap(element, () => {
      b.add(`{ tag: ${JSON.stringify(element.name)}, props: { `)

      if (element.classes.length > 0)
        b.add(`"class": ${JSON.stringify(element.classes.map(span => this.text(span)).join(' '))}, `)

      if (element.id)
        b.add(`"id": ${JSON.stringify(this.text(element.id))}, `)

      for (const attribute of element.attributes) {
        if (attribute.kind === 'spread') {
          b.add('...(').addSource(attribute.expression).add('), ')

          continue
        }

        b.add(`${JSON.stringify(this.text(attribute.name))}: `)

        if (attribute.kind === 'static')
          b.add(JSON.stringify(attribute.text))
        else if (attribute.kind === 'expression')
          b.add('(').addSource(attribute.expression).add(')')
        else
          b.add('true')

        b.add(', ')
      }

      const lines = element.children.filter(child => child.kind === 'text')

      if (lines.length > 0) {
        b.add('"children": ""')
        for (const [index, line] of lines.entries()) {
          if (index > 0)
            b.add(' + "\\n"')

          for (const part of line.parts) {
            if (part.kind === 'expression')
              b.add(' + (').addSource(part.expression).add(')')
            else if (part.kind === 'chunk')
              b.add(` + ${JSON.stringify(part.text)}`)
          }
        }
      }

      b.add(' } }')
    })
  }

  private text(span: Span): string {
    return this.src.slice(span.start, span.end)
  }
}

// A component needs the browser when it handles events, binds inputs, takes refs or holds reactive state.
export function isInteractive(file: KayFile, script: ScriptAnalysis): boolean {
  return script.reactive || templateFacts(file).interactive
}

// Whether a static component passes a component what may be a function, a class or an instance of one, or a block taking parameters: should that component be an island, it renders as one itself.
export function mayPromote(file: KayFile, script: ScriptAnalysis): boolean {
  const names = new Set([...script.functions, ...script.imports.filter(binding => !binding.typeOnly).map(binding => binding.local)])

  return someNode(file.template, node => node.kind === 'element' && node.component && (node.attributes.some(attribute => (attribute.kind === 'expression' || attribute.kind === 'spread') && mayHoldFunction(file.source.slice(attribute.expression.start, attribute.expression.end), names)) || node.children.some(child => child.kind === 'slot' && child.params !== undefined)))
}

type KayHelper = 'formAction' | 'formValue' | 'formChecked' | 'formInvalid' | 'formError' | 'formProtection' | 'registerActions' | 'actionStub' | 'autoDefer'

type Helper = TemplateHelper | 'omit'

// The members of `TemplateHelpers` in src/runtime/checks.ts.
type DeclaredHelper = Helper | 'staticFor' | 'Dynamic' | 'head' | 'Try'

// `T extends Record<string, U>, const U = number` names `T` and `U`: the first identifier of each parameter, split at the commas outside any brackets.
function typeParameterNames(parameters: string): string[] {
  const names: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index <= parameters.length; index++) {
    const char = parameters[index]

    if (char === '<' || char === '(' || char === '[' || char === '{')
      depth++
    else if ((char === '>' && parameters[index - 1] !== '=') || char === ')' || char === ']' || char === '}')
      depth--

    if (index < parameters.length && (char !== ',' || depth > 0))
      continue

    const name = TYPE_PARAMETER_NAME.exec(parameters.slice(start, index))?.[1]

    if (name !== undefined)
      names.push(name)

    start = index + 1
  }

  return names
}

// The message keys an island's source names, as the third argument to `island()`, or nothing for an island naming none.
export function islandMessages(source: string, client = false): string {
  const keys = [...new Set(Array.from(source.matchAll(MESSAGE_KEY), match => match[2]!))]

  if (client)
    return `, ${JSON.stringify(keys)}, true`

  return keys.length > 0 ? `, ${JSON.stringify(keys)}` : ''
}

// The server values the template's `await` blocks render by name, which `load` defers.
function deferredData(facts: TemplateFacts, server: ServerAnalysis | undefined): Set<string> {
  const data = new Set(server?.data.map(binding => binding.name))

  return new Set([...facts.awaited].filter(name => data.has(name)))
}
