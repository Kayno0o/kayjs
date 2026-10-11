import type { Attribute, AwaitBranch, AwaitNode, ConstNode, Details, Diagnostic, ElementNode, ErrorNode, ForNode, IfNode, KayFile, Labelled, NamedAttribute, Node, ServerIslandMark, SlotNode, Span, TemplateFacts, TemplateHelper, TextNode, TryNode } from './ast'
import type { LintName } from './lints'
import type { Rewrite } from './mapping'
import type { PageSettingName } from './page-settings'
import type { ImportBinding, ScriptAnalysis, ServerAnalysis } from './script'
import { actionUrl } from '../runtime/action'
import { actionOf, errorMessages, FIELD_ATTRIBUTE, FIELD_ELEMENTS, isChildrenSlot, isHead, isSlot, serverIslandOf, someNode, visitNodes } from './ast'
import { domHelperImport, DomTemplate } from './dom'
import { isFunctionExpression, mayHoldFunction } from './expression'
import { htmlHelperImport, HtmlTemplate } from './html'
import { sourceLocator } from './inspect'
import { constDeclaration, slotValue } from './items'
import { CodeBuilder, DYNAMIC_TAG } from './mapping'
import { PAGE, PAGE_SETTINGS } from './page-settings'

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
  diagnostics: Diagnostic[]
}

// JSX collapses a run of spaces in text, which `pre` and `textarea` would show, so a run goes out as a string.
const JSX_TEXT_ESCAPES = /[{}<>]|[ \t]{2,}/g
const BINDABLE = new Set(['input', 'textarea', 'select'])
const TRANSITION_PART = 'transition:'
const TRANSITION_PARTS = new Set(['enter', 'enter-from', 'enter-to', 'leave', 'leave-from', 'leave-to'])
const NUMERIC_INPUTS = new Set(['number', 'range'])
const FORM_FIELDS = new Set(['input', 'select', 'textarea', 'button'])
const LINK_ELEMENTS = new Set(['a', 'area'])
// Attributes rendered as markup rather than text.
const MARKUP_ATTRIBUTES = new Set(['innerHTML', 'srcdoc'])
// URLs checked as links are when written out: an expression there may be another kind of value, such as an action a form posts to.
const WRITTEN_URLS = new Map([['img', 'src'], ['link', 'href'], ['form', 'action']])
const WHITESPACE = /\s+/
const CTX_REFERENCE = /\bctx\b/
const EVENT_HANDLER = /^on[A-Z]/
const LOWERCASE_EVENT = /^on:?([a-z]+)$/
const COMPOUND_EVENT = /^(dbl|key|mouse|pointer|touch|drag|focus|context|before|after)(click|down|up|press|move|enter|leave|over|out|start|end|cancel|in|menu|input)$/
const IMPORT_COMMA_AFTER = /^\s*,\s*/
const IMPORT_COMMA_BEFORE = /,\s*$/
const DEFAULT_PREFIX = '__default_'
const HEAD_TAGS = new Set(['title', 'meta', 'link', 'style', 'script', 'base'])
// `kay build` renders the page once when it is `true`.
const PRERENDER: PageSettingName = 'prerender'
const IDENTIFIER = /^[A-Z_$][\w$]*$/i
// The page's query schema, which types and validates `ctx.query`.
const QUERY: PageSettingName = 'query'
// `t('nav.home')` or `T(key="intro")`: a message key an island's source names as it is written.
const MESSAGE_KEY = /(?:\bt\(\s*|\bT\([^)]*?\bkey=)(['"`])([\w.-]+)\1/g
// The server exports that are no actions: the page's settings, and each under its own name as they were exported before.
const NOT_ACTIONS = new Set<string>([PAGE, ...PAGE_SETTINGS])
// What only a static parent passes an island.
const ISLAND_OPTIONS = new Set(['hydrate', 'persist'])
// A type parameter's name, past the `const`, `in` and `out` modifiers it may carry.
const TYPE_PARAMETER_NAME = /^\s*(?:(?:const|in|out)\s+)*([A-Z_$][\w$]*)/i
// Elements a keyboard reaches and a screen reader announces as controls; a click handler on any other one needs a `role`.
const INTERACTIVE_TAGS = new Set(['a', 'audio', 'button', 'details', 'embed', 'iframe', 'input', 'label', 'object', 'option', 'select', 'summary', 'textarea', 'video'])
// An attribute an element needs to be understood without seeing it, and what to write.
const REQUIRED_TEXT = new Map<string, [attribute: string, message: string, help: string]>([
  ['img', ['alt', 'An `img` needs `alt`', 'say what it shows, or write `alt=""` when it is only decoration']],
  ['iframe', ['title', 'An `iframe` needs a `title`', 'name what it holds, which screen readers announce']],
])
const HEAD_CONTENT = 'A `head` block holds `title`, `meta`, `link`, `style`, `script` and `base` elements only'

export function defaultName(index: number): string {
  return `${DEFAULT_PREFIX}${index}`
}

export function generate(file: KayFile, script: ScriptAnalysis, server: ServerAnalysis | undefined, options: GenerateOptions): Generated {
  return new Generator(file, script, server, options).run()
}

class Generator {
  private readonly b: CodeBuilder
  private readonly accessorSites = new Set<number>()
  private readonly constSites = new Set<number>()
  private readonly diagnostics: Diagnostic[] = []
  private readonly src: string
  // The action expression of the form being emitted, so its fields' names are checked against the action's input.
  private formTarget: Span | undefined
  // Server values an `await` block renders by name, which `load` defers once they are declared.
  private deferred = new Set<string>()

  constructor(private readonly file: KayFile, private readonly script: ScriptAnalysis, private readonly server: ServerAnalysis | undefined, private readonly options: GenerateOptions) {
    this.src = file.source
    this.b = new CodeBuilder(file.source, options.rewrites)
  }

  run(): Generated {
    const { b, script, server } = this
    const includeServer = server !== undefined && this.options.includeServer !== false
    // What the fences use from `kay` unimported, as they use `props<T>()`; a name the other fence of the same module imports needs no import.
    const imported = new Set([...script.imports, ...includeServer ? server.imports : []].map(binding => binding.local))
    const implicit = [...script.implicit, ...includeServer ? server.implicit : []].filter(name => !imported.has(name))

    if (implicit.length > 0)
      b.add(`import { ${[...new Set(implicit)].join(', ')} } from 'kay'\n`)

    if (this.options.translates === true && !imported.has('t'))
      b.add('import { t } from \'kay/i18n\'\n')

    for (const span of script.hoisted)
      this.emitHoisted(span, script.specifiers, script.imports, [])

    if (includeServer) {
      const duplicates = this.duplicateImports(script, server)

      for (const span of server.hoisted)
        this.emitHoisted(span, server.specifiers, server.imports, duplicates)
    }

    const query = this.declaresQuery()

    if (server)
      b.add(`import type { ${this.options.errorPage ? 'ErrorPageContext' : 'PageContext'} as KayPageContext, PageData as KayPageData${query !== undefined ? ', QueryOf as KayQueryOf' : ''}${this.settingType(PRERENDER) !== undefined ? ', PrerenderedContext as KayPrerenderedContext' : ''}${this.options.check && server.page ? ', PageSettings as KayPageSettings' : ''} } from 'kay'\n`)

    const facts = templateFacts(this.file)
    const kayHelpers: KayHelper[] = facts.actionForm ? ['formAction'] : []
    const actions = server?.exportNames.filter(name => !NOT_ACTIONS.has(name)) ?? []
    const staticLoops = this.staticLoops
    const html = this.final('html')
    const dom = this.final('dom')
    const runnable = html || dom
    const used: Helper[] = [...script.props?.rest ? ['omit' as const] : [], ...facts.helpers]
    const helpers = runnable ? [] : used.filter(helper => helper !== 'For')

    if (includeServer) {
      const data = new Set(server.data.map(binding => binding.name))

      this.deferred = new Set([...facts.awaited].filter(name => data.has(name)))
    }

    if (this.deferred.size > 0)
      kayHelpers.push('autoDefer')

    // What fills a form's fields back in once a post was refused.
    if (runnable && kayHelpers.includes('formAction'))
      kayHelpers.push('formValue', 'formChecked', 'formInvalid', 'formError')

    if (html && kayHelpers.includes('formAction'))
      kayHelpers.push('formProtection')

    if (includeServer ? server.exportNames.length > 0 : actions.length > 0)
      kayHelpers.push(includeServer ? 'registerActions' : 'actionStub')

    if (kayHelpers.length > 0)
      b.add(`import { ${kayHelpers.map(helper => `${helper} as ${kayAlias(helper)}`).join(', ')} } from 'kay/internal'\n`)

    if (server && !includeServer) {
      for (const name of actions)
        b.add(`export const ${name} = KayActionStub(${JSON.stringify(actionUrl(this.options.moduleId, name))})\n`)
    }

    const childrenSlot = facts.childrenSlot
    const childrenType = ' & { children?: KayJSX.Element }'

    if (childrenSlot)
      b.add(`import type { JSX as KayJSX } from 'kay'\n`)

    if (html)
      b.add(htmlHelperImport())

    if (dom)
      b.add(domHelperImport())

    // Code that only gets read, by the type checker and the analysis pass, declares the helpers of its control flow rather than import a runtime of them.
    const declared: [name: string, helper: DeclaredHelper][] = helpers.map(helper => [helperAlias(helper), helper])

    if (used.includes('For') && !runnable)
      declared.push(staticLoops ? ['KayStaticFor', 'staticFor'] : ['KayLoopFor', 'For'])

    if (this.options.island !== undefined)
      b.add(`import { island as KayIsland } from 'kay/island'\n`)

    if (this.options.twin !== undefined)
      b.add(`import { ${this.options.promote === undefined ? 'insideIsland as KayInsideIsland' : 'promote as KayPromote'} } from 'kay/island'\nimport KayHydrated from ${JSON.stringify(this.options.twin)}\n`)

    if (this.options.island !== undefined && this.genericComponent)
      b.add(`import type { IslandBrand as KayIslandBrand, IslandOptions as KayIslandOptions } from 'kay'\n`)

    if (facts.await && !dom)
      b.add(`import { Await as KayAwait } from 'kay/await'\n`)

    if (facts.try && !runnable)
      declared.push(['KayTry', 'Try'])

    if (!runnable && this.options.rewrites && [...this.options.rewrites.values()].some(rewrite => rewrite.dynamic))
      declared.push([DYNAMIC_TAG, 'Dynamic'])

    const { head, hoisted, template } = this.splitHead(this.file.template)

    if (head && !this.options.check && !runnable)
      declared.push(['KayUseHead', 'head'])

    if (declared.length > 0) {
      b.add(`import type { TemplateHelpers as KayTemplateHelpers } from 'kay'\n`)

      for (const [name, helper] of declared)
        b.add(`declare const ${name}: KayTemplateHelpers[${JSON.stringify(helper)}]\n`)
    }

    if (includeServer)
      this.emitLoad(server, query)

    b.add(`\n${this.options.island !== undefined || this.options.twin !== undefined ? '' : 'export default '}function ${this.options.name}`)

    if (this.file.typeParameters) {
      if (server)
        this.error(this.file.typeParameters, 'A page has no type parameters', { note: 'a page gets its data from `--- server` and takes no props' })
      else
        b.add('<').addSource(this.file.typeParameters).add('>')
    }

    b.add('(')

    if (server) {
      b.add(`__props: KayPageData<typeof load>${childrenSlot ? childrenType : ''}`)

      if (script.props)
        this.error(script.props.statement, 'A page declares no props', { note: 'a page gets its data from `--- server`', help: 'read the server names directly' })
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
    else if (facts.slot) {
      b.add('__props: {}')
    }

    b.add(') {\n')
    this.emitBody()

    for (const node of hoisted)
      this.emitHoistedConst(node, html || dom)

    // An island sets no head, and a static component rendering inside one leaves it to the server.
    if (head && !dom)
      this.emitHead(head)

    b.add('\nreturn ')

    const errors = html || dom ? errorMessages(template, this.src) : undefined
    const located = this.options.inspect === true ? sourceLocator(this.src, this.options.moduleId) : undefined
    const domTemplate = dom ? new DomTemplate(b, this.src, errors, located) : undefined

    if (html)
      new HtmlTemplate(b, this.src, { hydratable: this.options.hydratable, accessorLoops: !staticLoops, errors, located }).value(this.withoutSlots(template))
    else if (domTemplate)
      domTemplate.block(this.withoutSlots(template))
    else
      this.emitRoot(template)

    b.add('\n}\n')

    if (domTemplate)
      b.add(domTemplate.declarations())

    if (this.options.twin !== undefined && this.options.promote !== undefined)
      b.add(`\nexport default KayPromote(${JSON.stringify(this.options.promote)}, ${this.options.name} as never, KayHydrated as never${islandMessages(this.src)}) as typeof ${this.options.name}\n`)
    else if (this.options.twin !== undefined)
      b.add(`\nexport default ((props: never) => KayInsideIsland() ? KayHydrated(props) : ${this.options.name}(props)) as typeof ${this.options.name}\n`)

    if (this.options.island !== undefined)
      b.add(`\nexport default KayIsland(${JSON.stringify(this.options.island)}, ${this.options.name}${this.genericComponent ? ' as never' : ''}${islandMessages(this.src, this.options.client)})${this.genericIslandType()}\n`)

    return { builder: b, accessorSites: this.accessorSites, constSites: this.constSites, diagnostics: this.diagnostics }
  }

  // The type of the page's query schema, when it declares one; a layout's or special page's declaration is reported.
  private declaresQuery(): string | undefined {
    const span = this.server?.page?.settings.get(QUERY)?.key

    if (span && this.options.special) {
      this.error(span, 'Only a page declares its query', { help: 'read the page\'s query through `ctx.query`' })

      return undefined
    }

    return this.settingType(QUERY)
  }

  // What `load` types a setting from: its key of `page`.
  private settingType(name: PageSettingName): string | undefined {
    return this.server?.page?.settings.has(name) ? `typeof ${PAGE}.${name}` : undefined
  }

  // The final pass builds what runs; the analysis pass always generates JSX.
  private final(output: 'html' | 'dom'): boolean {
    return this.options.output === output && this.options.rewrites !== undefined
  }

  // Whether the props the template passes an island are sent to the browser as they are: a page, a layout, or a static component that would not render as an island in its place.
  private get sendsIslandProps(): boolean {
    return this.options.island === undefined && !this.options.insideIsland && this.options.promote === undefined
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

  // Both fences land in one module, so a name they both import is declared once; the server fence's copy is the one left out, and a name imported two different ways is reported.
  private duplicateImports(script: ScriptAnalysis, server: ServerAnalysis): ImportBinding[] {
    const seen = new Map(script.imports.map(binding => [binding.local, binding]))
    const duplicates: ImportBinding[] = []

    for (const binding of server.imports) {
      const first = seen.get(binding.local)

      if (!first) {
        seen.set(binding.local, binding)

        continue
      }

      if (first.imported === binding.imported && first.source === binding.source && (binding.typeOnly || !first.typeOnly))
        duplicates.push(binding)
      else
        this.error(binding.span, `\`${binding.local}\` is imported twice, once in each fence, and not the same way`, { related: [{ ...first.span, label: 'first imported here' }], help: 'import it once' })
    }

    return duplicates
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
  private emitLoad(server: ServerAnalysis, query: string | undefined) {
    const { b } = this
    // Typed where it is written, so the editor completes its keys and `kay check` reports one kay does not know.
    const page = this.options.check ? server.page?.init : undefined

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
    b.add(`\nreturn { ${server.data.map(data => this.deferred.has(data.name) ? `${data.name}: ${kayAlias('autoDefer')}(${data.name})` : data.name).join(', ')} }\n}\n`)
  }

  // Right where a deferred value is declared, so a promise rejecting while a later statement awaits crashes nothing; a statement an export reads runs at module level.
  private deferDeclared(server: ServerAnalysis, span: Span) {
    for (const data of server.data) {
      if (this.deferred.has(data.name) && data.local.start >= span.start && data.local.end <= span.end)
        this.b.add(`\n${kayAlias('autoDefer')}(${data.name})\n`)
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
      b.add('const ').addSource(props.rest).add(` = ${helperAlias('omit')}(__props, ${props.bindings.map(binding => JSON.stringify(binding.key)).join(', ')});\n`)

    // The analysis pass declares the destructured names so scope analysis can find every read of them; the final pass rewrites those reads instead.
    if (!this.options.rewrites && props.bindings.length > 0) {
      b.add('const { ')
      for (const binding of props.bindings)
        b.add(`${JSON.stringify(binding.key)}: `).addSource(binding.local).add(', ')
      b.add('} = __props;\n')
    }
    // Type checking keeps each `{ title }` as a read of its prop, so the editor hovers, finds and renames it with the prop.
    else if (this.options.check) {
      for (const binding of props.bindings) {
        if (this.text(binding.local) === binding.key)
          b.add('__props.').addSource(binding.local).add(';\n')
      }
    }
  }

  // A top-level `const` before the `head` block, declared ahead of it so the head reads it too.
  private emitHoistedConst(node: ConstNode, final: boolean) {
    const { b } = this
    const memo = this.staticLoops ? undefined : 'KayMemo'

    if (final) {
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

      if (head)
        this.error(node.tag, 'A template has one `head` block', { related: [{ ...head.tag, label: 'the first one' }] })
      else if (this.options.island !== undefined)
        this.error(node.tag, 'An island cannot set the document head', { note: 'an island also renders in the browser', help: 'move the `head` block to its page' })
      else if (node.attributes.length > 0 || node.classes.length > 0 || node.id)
        this.error(node, 'A `head` block takes no attributes')

      head ??= node
    }

    return { head, hoisted, template }
  }

  // Registered before the template renders, so a page's title and meta tags win over its layouts': they render first and register first.
  private emitHead(head: ElementNode) {
    const { b } = this
    const tags = head.children.filter((child): child is ElementNode => this.isHeadTag(child))

    if (this.options.check) {
      b.add('void (<>')
      this.emitChildren(tags)
      b.add('</>);\n')

      return
    }

    b.add(this.final('html') ? 'KayHead([' : 'KayUseHead([')
    for (const tag of tags) {
      this.emitHeadTag(tag)
      b.add(', ')
    }
    b.add(']);\n')
  }

  private isHeadTag(node: Node): boolean {
    if (node.kind !== 'element' || node.component || !HEAD_TAGS.has(node.name)) {
      this.error(node, HEAD_CONTENT)

      return false
    }

    const nested = node.children.find(child => child.kind !== 'text' || child.parts.some(part => part.kind === 'element'))

    if (nested)
      this.error(nested, `\`${node.name}\` holds text only`)

    return nested === undefined
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

  private emitRoot(nodes: Node[]) {
    const visible = this.withoutSlots(nodes)

    if (visible.length === 1 && visible[0]!.kind === 'element' && !isSlot(visible[0]!)) {
      this.emitElement(visible[0]!)

      return
    }

    if (visible.length === 0) {
      this.b.add('null')

      return
    }

    this.b.add('<>')
    this.emitChildren(visible)
    this.b.add('</>')
  }

  // Branch and loop bodies as one expression: a lone element stays bare, several get a fragment.
  private emitChildren(nodes: Node[]) {
    let previous: Node | undefined

    for (const [index, node] of nodes.entries()) {
      switch (node.kind) {
        case 'const':
          this.emitConst(node, nodes.slice(index + 1))

          return
        case 'element':
          this.emitElement(node)

          break
        case 'text':
          // JSX folds a line break into a space, so the line break between two text lines is an expression.
          if (previous?.kind === 'text')
            this.b.add('{"\\n"}')

          this.emitText(node)

          break
        case 'if':
          this.b.wrap(node, () => {
            this.b.add('{')

            if (node.subject)
              this.emitMatch(node, node.subject)
            else
              this.emitIf(node, 0)

            this.b.add('}')
          })

          break
        case 'for':
          this.emitFor(node)

          break
        case 'await':
          this.emitAwait(node)

          break
        case 'try':
          this.emitTry(node)

          break
        case 'slot':
          this.reportSlot(node)

          break
        case 'error':
          this.emitError(node)

          break
      }

      previous = node
    }
  }

  // The siblings after a `const` render inside a function declaring it, so its name reaches them and their children alone.
  private emitConst(node: ConstNode, rest: Node[]) {
    const { b } = this

    b.add('{(() => { ')
    b.wrap(node, () => {
      b.add('const ')
      this.constSites.add(b.code.length)

      // Code that runs reads it as a memo, as it does a row, unless the markup renders once.
      if (!this.staticLoops)
        this.accessorSites.add(b.code.length)

      b.addSource(node.pattern).add(' = (').addSource(node.value).add(');')
    })
    b.add(' return ')
    this.emitRoot(rest)
    b.add(' })()}')
  }

  // The field's name is typed as a `name` is: one of the action's input.
  private emitError(node: ErrorNode) {
    const { b } = this

    if (!this.formTarget) {
      this.error(node, '`error` shows the message of a form posting to an action, so it sits inside one', { help: 'move it into the `form(action={...})` whose post it reports on' })

      return
    }

    if (!this.options.check)
      return

    b.wrap(node, () => {
      b.add('{KayFormError((').addSource(this.formTarget!).add(')')

      if (node.field) {
        b.add(', ')
        b.wrap(node.field, () => b.add(JSON.stringify(node.name)))
      }

      b.add(')}')
    })
  }

  // A `switch`, so `kay check` narrows the subject in each branch and reports a value its type cannot hold.
  private emitMatch(node: IfNode, subject: Span) {
    const { b } = this

    b.add('(() => { switch (').addSource(subject).add(') { ')

    for (const branch of node.branches) {
      b.wrap(branch, () => {
        for (const value of branch.values ?? [])
          b.add('case ').addSource(value).add(': ')

        b.add(branch.values ? 'return (' : 'default: return (')
        this.emitRoot(branch.children)
        b.add('); ')
      })
    }

    b.add(node.branches.some(branch => !branch.values) ? '} })()' : '} return null })()')
  }

  private emitIf(node: IfNode, index: number) {
    const branch = node.branches[index]!
    const { b } = this

    b.wrap(branch, () => {
      if (!branch.test) {
        this.emitRoot(branch.children)

        return
      }

      const hasRest = index + 1 < node.branches.length

      if (branch.alias) {
        b.add(`<${helperAlias('Show')} when={`).addSource(branch.test).add('}')

        if (hasRest) {
          b.add(' fallback={')
          this.emitIf(node, index + 1)
          b.add('}')
        }

        b.add('>{(')
        this.accessorSites.add(b.code.length)
        b.addSource(branch.alias).add(') => ')
        this.emitRoot(branch.children)
        b.add(`}</${helperAlias('Show')}>`)

        return
      }

      b.add('(').addSource(branch.test).add(') ? ')
      this.emitRoot(branch.children)
      b.add(' : ')

      if (hasRest)
        this.emitIf(node, index + 1)
      else
        b.add('null')
    })
  }

  // A component taking each block as a function, so the browser and the server each decide when to render which.
  private emitAwait(node: AwaitNode) {
    const { b } = this

    b.wrap(node, () => {
      // An error about the value, such as a promise `defer()` never took, lands on the value itself.
      b.add('<KayAwait ')
      b.wrap(node.value, () => b.add('value'))
      b.add('={').addSource(node.value).add('}')

      if (node.pending.length > 0) {
        b.add(' pending={() => ')
        this.emitRoot(node.pending)
        b.add('}')
      }

      if (node.resolved)
        this.emitAwaitBranch('ready', node.resolved)

      if (node.rejected)
        this.emitAwaitBranch('failed', node.rejected)

      b.add(' />')
    })
  }

  private emitTry(node: TryNode) {
    const { b } = this

    b.wrap(node, () => {
      b.add('<KayTry block={() => ')
      this.emitRoot(node.children)
      b.add('}')

      if (node.rejected)
        this.emitAwaitBranch('failed', node.rejected)

      b.add(' />')
    })
  }

  private emitAwaitBranch(prop: 'ready' | 'failed', branch: AwaitBranch) {
    const { b } = this

    b.wrap(branch, () => {
      b.add(` ${prop}={(`)

      if (branch.alias)
        b.addSource(branch.alias)

      b.add(') => ')
      this.emitRoot(branch.children)
      b.add('}')
    })
  }

  // Pages, layouts and static components outside islands render once on the server and never hydrate, so their loops hand each row its item rather than an accessor to it.
  private get staticLoops(): boolean {
    if (this.options.check || this.options.island !== undefined)
      return false

    return this.options.output === 'html' || this.options.twin !== undefined || (this.server !== undefined && this.options.includeServer !== false)
  }

  private emitFor(node: ForNode) {
    const { b } = this

    if (this.staticLoops) {
      this.emitStaticFor(node)

      return
    }

    const tag = 'KayLoopFor'
    // A key naming the index means rows are matched by position: `for row, i of rows key={i}`.
    const positional = node.index !== undefined && node.key !== undefined && this.text(node.key).trim() === this.text(node.index)

    // Only an island renders a list again, so only there do rows matched by their objects cost anything.
    const identityChecked = this.options.check === true && (this.options.island !== undefined || this.options.insideIsland === true) && !node.key

    b.wrap(node, () => {
      b.add(`<${tag} each={`)

      if (identityChecked)
        b.add('KayIdentityKey((').addSource(node.each).add('))')
      else
        b.addSource(node.each)

      b.add('} keyed={')

      if (positional)
        b.add('false')
      else if (node.key)
        b.add('(').addSource(node.item).add(') => (').addSource(node.key).add(')')
      // Rows keyed by the item's `id` or the item itself, which any item has.
      else
        b.add('() => 0')

      b.add('}')

      if (node.fallback) {
        b.add(' fallback={')
        this.emitRoot(node.fallback)
        b.add('}')
      }

      b.add('>{(')
      this.accessorSites.add(b.code.length)
      b.addSource(node.item)

      if (node.index) {
        b.add(', ')

        if (!positional)
          this.accessorSites.add(b.code.length)

        b.addSource(node.index)
      }

      b.add(') => ')

      // A positional key reads the index, so the type check sees it read, and hover and rename reach the key's name.
      if (positional && node.key && this.options.check) {
        b.add('(void (').addSource(node.key).add('), ')
        this.emitRoot(node.children)
        b.add(')')
      }
      else {
        this.emitRoot(node.children)
      }

      b.add(`}</${tag}>`)
    })
  }

  // Nothing here updates, so the loop's callback gets the item and the index themselves rather than `For`'s accessors.
  private emitStaticFor(node: ForNode) {
    const { b } = this

    b.wrap(node, () => {
      b.add('{KayStaticFor(').addSource(node.each).add(', (')
      b.addSource(node.item)

      if (node.index)
        b.add(', ').addSource(node.index)

      b.add(`) => `)
      this.emitRoot(node.children)

      if (node.fallback) {
        b.add(', () => ')
        this.emitRoot(node.fallback)
      }

      b.add(')}')
    })
  }

  private emitElement(element: ElementNode) {
    const { b } = this

    if (this.options.check && !element.component)
      this.checkAccessibility(element)

    if (isHead(element))
      this.error(element, 'A `head` block sits at the top level of a template')

    if (isSlot(element)) {
      if (element.attributes.length > 0 || element.classes.length > 0 || element.id)
        this.error(element, '`slot` takes no attributes', { note: '`slot` marks where a layout or wrapper renders its children, and `slot name` its `name` block prop' })

      b.wrap(element, () => {
        b.add('{')
        slotValue(b, element)

        if (element.children.length > 0) {
          b.add(' ?? ')
          this.emitRoot(element.children)
        }

        b.add('}')
      })

      return
    }

    b.wrap(element, () => {
      b.add('<')

      const named = element.tag.end > element.tag.start
      const dynamic = named ? b.addTag(element.tag) : false

      if (!named)
        b.add(element.name)

      this.emitAttributes(element)
      const slots = element.children.filter((child): child is SlotNode => child.kind === 'slot')
      const children = element.children.filter(child => child.kind !== 'slot')

      // Each prop is passed once: by an attribute, by an `@name` block, or for `children` by the lines under the tag.
      const passed = new Map<string, Labelled>(element.attributes.flatMap(attribute => attribute.kind === 'spread' ? [] : [[this.text(attribute.name), { ...attribute.name, label: 'passed by this attribute' }]]))

      if (children.length > 0)
        passed.set('children', { start: children[0]!.start, end: children[0]!.end, label: 'passed by the lines under the tag' })

      for (const slot of slots) {
        if (!element.component) {
          this.reportSlot(slot)

          continue
        }

        const name = this.text(slot.name)
        const earlier = passed.get(name)

        if (earlier !== undefined)
          this.error(slot.name, `\`${name}\` is passed twice`, { label: 'passed again here', related: [earlier] })

        passed.set(name, { ...slot.name, label: `passed by this \`@${name}\`` })

        // `@row(todo)` passes a function the component calls per item, its parameters typed from the prop.
        if (slot.params && this.options.check && this.sendsIslandProps) {
          b.add(' ')
          this.emitFunctionPropCheck(element, slot.name)
        }

        b.add(' ').addSource(slot.name).add('={')

        if (slot.params)
          b.add('(').addSource(slot.params).add(') => ')

        this.emitRoot(slot.children)
        b.add('}')
      }

      if (children.length === 0) {
        b.add(' />')

        return
      }

      b.add('>')
      const outerForm = this.formTarget
      const action = actionOf(element, this.src)

      if (action)
        this.formTarget = action.expression

      this.emitChildren(children)
      this.formTarget = outerForm
      b.add('</')

      // The closing tag reads the name the way the opening one did: a prop, a loop item or a server value may be the component.
      if (dynamic)
        b.add(DYNAMIC_TAG)
      else if (named)
        b.addSource(element.tag)
      else
        b.add(element.name)

      b.add('>')
    })
  }

  private checkServerIsland({ attribute, mode, noscript }: ServerIslandMark): void {
    if (this.options.island !== undefined || this.options.insideIsland)
      this.error(attribute.name, '`server` has no effect inside an island', { note: 'an island renders in the browser too, as a whole' })
    else if (mode === undefined)
      this.error(attribute.name, '`server` takes no value, or "defer"', { help: '`server` renders it per request inside the prerendered page, `server="defer"` once the browser fetches it on approach' })
    else if (noscript && mode !== 'defer')
      this.error(noscript.name, '`noscript` only goes with `server="defer"`', { note: 'an inline server island arrives with the page, so it needs no JavaScript' })
    else if (noscript?.kind === 'boolean')
      this.error(noscript.name, '`noscript` takes the text of its link', { help: 'such as `noscript="Show the contact form"`' })
  }

  private emitAttributes(element: ElementNode) {
    const serverIsland = serverIslandOf(element, this.src)
    const { b } = this

    if (element.id) {
      if (element.attributes.some(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === 'id'))
        this.error(element.id, 'The id is set twice', { label: 'set by `#id`', related: element.attributes.flatMap(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === 'id' ? [{ ...attribute.name, label: 'and by this attribute' }] : []) })

      b.add(' id="').addSource(element.id).add('"')
    }

    const classAttributes = element.attributes.filter((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && this.text(attribute.name) === 'class')

    if (classAttributes.length > 1)
      this.error(classAttributes[1]!.name, 'An element takes one `class` attribute', { related: [{ ...classAttributes[0]!.name, label: 'the first one' }], help: 'put several classes in one: `class="a b"`' })

    // A spread may carry a `class` of its own, which merges in too, so the class goes after every attribute and spread.
    const spreads = element.attributes.some(attribute => attribute.kind === 'spread')
    const merged = spreads && (element.classes.length > 0 || classAttributes.length > 0)

    if (element.classes.length > 0 && !spreads)
      this.emitShorthandClass(element, classAttributes[0])

    for (const attribute of element.attributes) {
      if ((element.classes.length > 0 || merged) && attribute === classAttributes[0])
        continue

      if (element.component && (this.options.island !== undefined || this.options.insideIsland) && attribute.kind !== 'spread' && ISLAND_OPTIONS.has(this.text(attribute.name)))
        this.error(attribute.name, `\`${this.text(attribute.name)}\` has no effect inside an island`, { note: 'an island hydrates and lives on as a whole' })

      if (attribute === serverIsland?.attribute) {
        this.checkServerIsland(serverIsland)

        continue
      }

      // Not a prop: what it reads is checked on its own.
      if (attribute === serverIsland?.noscript) {
        if (attribute.kind === 'expression')
          b.add(' {...(void (').addSource(attribute.expression).add('), {})}')

        continue
      }

      b.add(' ')

      if (!this.emitFormAttribute(element, attribute))
        this.emitAttribute(element, attribute)
    }

    if (merged)
      this.emitMergedClass(element, classAttributes[0])

    if (actionOf(element, this.src)) {
      const named = (name: string) => element.attributes.some(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === name)

      if (!named('method'))
        b.add(' method="post"')

      // Multipart whatever the schema, so file inputs post too; Elysia parses either encoding alike.
      if (!named('enctype'))
        b.add(' enctype="multipart/form-data"')
    }
  }

  // `form(action={add})` posts to the action's URL, and each field `name` inside it must be a key of the action's input.
  private emitFormAttribute(element: ElementNode, attribute: Attribute): boolean {
    const { b } = this

    if (attribute.kind === 'expression' && attribute === actionOf(element, this.src)) {
      b.addSource(attribute.name).add(`={${kayAlias('formAction')}((`).addSource(attribute.expression).add('))}')

      return true
    }

    if (attribute.kind === 'spread' || element.component)
      return false

    const name = this.text(attribute.name)

    if (name === FIELD_ATTRIBUTE ? !FIELD_ELEMENTS.has(element.name) : name !== 'name' || !FORM_FIELDS.has(element.name))
      return false

    // `field` writes `name`, and the constraints of the action's schema, which only a form posting to one has.
    if (name === FIELD_ATTRIBUTE) {
      const named = element.attributes.find((other): other is NamedAttribute => other.kind !== 'spread' && this.text(other.name) === 'name')

      if (!this.formTarget)
        this.error(attribute.name, '`field` names a field of a form posting to an action, so it sits inside one', { help: 'write `name` for a form posting elsewhere' })
      else if (attribute.kind !== 'static')
        this.error(attribute.name, '`field` takes the field\'s name as written text', { note: 'its constraints are read off the action\'s schema by that name', help: 'write `field="title"`, or `name={...}` for a name computed at render' })
      else if (named)
        this.error(attribute.name, 'A field has `field` or `name`, not both', { related: [{ ...named.name, label: 'named here' }], help: 'drop `name`: `field` writes it' })

      if (attribute.kind !== 'static' || named) {
        b.add('{...{}}')

        return true
      }
    }

    if (!this.options.check || !this.formTarget || attribute.kind !== 'static') {
      if (name !== FIELD_ATTRIBUTE)
        return false

      b.wrap(attribute.name, () => b.add('name')).add(`=${JSON.stringify(attribute.kind === 'static' ? attribute.text : '')}`)

      return true
    }

    b.wrap(attribute.name, () => b.add('name')).add('={KayField((').addSource(this.formTarget).add('), ')
    b.wrap(attribute.value, () => b.add(JSON.stringify(attribute.text)))
    b.add(')}')

    return true
  }

  private emitShorthandClass(element: ElementNode, attribute: NamedAttribute | undefined) {
    const { b } = this
    const shorthand = element.classes.map(span => this.text(span)).join(' ')
    const source = { start: element.classes[0]!.start, end: element.classes.at(-1)!.end }

    b.add(' ')

    if (!attribute) {
      b.wrap(source, () => b.add(`class=${quoteAttribute(shorthand)}`))

      return
    }

    if (attribute.kind === 'static') {
      b.wrap(source, () => b.add(`class=${quoteAttribute(`${shorthand} ${attribute.text}`)}`))

      return
    }

    if (attribute.kind === 'expression') {
      const [open, close] = element.component ? [`${helperAlias('componentClass')}([`, '])'] : ['[', ']']

      b.addSource(attribute.name).add(`={${open}${JSON.stringify(shorthand)}, (`).addSource(attribute.expression).add(`)${close}}`)

      return
    }

    this.error(attribute.name, '`class` needs a value')
  }

  // The shorthand, the `class` attribute and the `class` each spread brings, in the order they were written.
  private emitMergedClass(element: ElementNode, classAttribute: NamedAttribute | undefined) {
    const { b } = this
    const shorthand = element.classes.length > 0 ? { start: element.classes[0]!.start, end: element.classes.at(-1)!.end } : undefined

    b.add(' ')
    b.wrap(classAttribute && (classAttribute.kind === 'expression' || !shorthand) ? classAttribute.name : shorthand!, () => b.add('class'))
    b.add(element.component ? `={${helperAlias('componentClass')}([` : '={[')

    if (shorthand)
      b.add(JSON.stringify(element.classes.map(span => this.text(span)).join(' ')))

    let separator = shorthand ? ', ' : ''

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread') {
        b.add(`${separator}((`).addSource(attribute.expression).add(') as unknown as { class?: string }).class')
        separator = ', '

        continue
      }

      if (attribute !== classAttribute)
        continue

      if (attribute.kind === 'static')
        b.add(`${separator}${JSON.stringify(attribute.text)}`)
      else if (attribute.kind === 'expression')
        b.add(`${separator}(`).addSource(attribute.expression).add(')')
      else
        this.error(attribute.name, '`class` needs a value')

      separator = ', '
    }

    b.add(element.component ? '])}' : ']}')
  }

  private emitAttribute(element: ElementNode, attribute: Attribute) {
    const { b } = this

    if (attribute.kind !== 'spread')
      this.checkTransition(element, attribute)

    if (this.options.check && this.emitCheckedAttribute(element, attribute))
      return

    if (!element.component && attribute.kind === 'expression')
      this.reportLowercaseEvent(attribute)

    switch (attribute.kind) {
      case 'spread':
        b.add('{...').addSource(attribute.expression).add('}')

        return
      case 'boolean':
        if (this.text(attribute.name).startsWith('bind:'))
          this.error(attribute.name, '`bind:` needs a signal', { help: '`bind:value={name}`' })

        b.addSource(attribute.name)

        return
      case 'static': {
        if (this.text(attribute.name).startsWith('bind:'))
          this.error(attribute.name, '`bind:` needs a signal', { help: '`bind:value={name}`' })

        b.addSource(attribute.name).add('=')
        const quoted = quoteAttribute(attribute.text)

        if (quoted === `"${attribute.text}"`)
          b.add('"').addSource(attribute.value).add('"')
        else
          b.wrap(attribute.value, () => b.add(quoted))

        return
      }
      case 'expression': {
        const name = this.text(attribute.name)

        if (name.startsWith('bind:')) {
          this.emitBind(element, attribute, name.slice(5))

          return
        }

        // Read at each event rather than once, as the browser build does, so a handler held by a prop, a signal or a loop item stays current.
        if (!element.component && !this.options.check && EVENT_HANDLER.test(name) && !isFunctionExpression(this.text(attribute.expression))) {
          b.addSource(attribute.name).add('={(kayEvent) => (').addSource(attribute.expression).add(')?.(kayEvent)}')

          return
        }

        b.addSource(attribute.name).add('={').addSource(attribute.expression).add('}')
      }
    }
  }

  // Type checking only, so a page still runs while it is fixed. A spread may carry what is missing, so an element with one is left alone.
  private checkAccessibility(element: ElementNode) {
    if (element.attributes.some(attribute => attribute.kind === 'spread'))
      return

    const names = new Set(element.attributes.map(attribute => this.text((attribute as Exclude<Attribute, { kind: 'spread' }>).name)))
    // `.card` has no tag of its own to point at.
    const at = element.tag.end > element.tag.start ? element.tag : element
    const required = REQUIRED_TEXT.get(element.name)

    if (required && !names.has(required[0]))
      this.lint(at, required[0] === 'alt' ? 'missing-alt' : 'missing-title', required[1], { help: required[2] })

    if (element.name === 'input' && this.staticAttribute(element, 'type') === 'image' && !names.has('alt'))
      this.lint(at, 'missing-alt', 'An image button needs `alt`', { help: 'name what it does' })

    if (names.has('onClick') && !names.has('role') && !INTERACTIVE_TAGS.has(element.name))
      this.lint(at, 'unreachable-click', `This \`${element.name}\` reacts to \`onClick\` but is out of reach of the keyboard and screen readers`, { help: 'use a `button`, or give it a `role` along with a `tabindex` and a key handler' })
  }

  // The text of an attribute written as a quoted string.
  private staticAttribute(element: ElementNode, name: string): string | undefined {
    for (const attribute of element.attributes) {
      if (attribute.kind === 'static' && this.text(attribute.name) === name)
        return attribute.text
    }

    return undefined
  }

  // `onclick` and `on:click` attach nothing, and the component would not become an island either.
  private reportLowercaseEvent(attribute: Extract<Attribute, { kind: 'expression' }>) {
    const name = LOWERCASE_EVENT.exec(this.text(attribute.name))?.[1]

    if (name === undefined)
      return

    const camel = `on${capitalize(name.replace(COMPOUND_EVENT, (_, first: string, second: string) => capitalize(first) + capitalize(second)))}`

    this.error(attribute.name, `\`${this.text(attribute.name)}\` does not attach a handler`, { note: 'events are written in camelCase', help: `\`${camel}\``, fixes: [{ title: `Write \`${camel}\``, edits: [{ ...attribute.name, text: camel }], safe: true }] })
  }

  // Check-only wrappers: a site link must match a page, markup must be made safe or written out, and a static parent passes an island serializable props only.
  private emitCheckedAttribute(element: ElementNode, attribute: Attribute): boolean {
    const { b } = this

    if (attribute.kind === 'boolean')
      return false

    // Spread props reach an island serialized as the others do, so the object is checked as one prop would be.
    if (attribute.kind === 'spread') {
      if (!element.component || !this.sendsIslandProps)
        return false

      b.add('{...KayProp(').addSource(element.tag).add(')((').addSource(attribute.expression).add('))}')

      return true
    }

    const name = this.text(attribute.name)

    if (!element.component && ((LINK_ELEMENTS.has(element.name) && name === 'href') || (attribute.kind === 'static' && WRITTEN_URLS.get(element.name) === name && !this.servedOtherwise(element)))) {
      b.addSource(attribute.name).add('={KayHref(')

      if (attribute.kind === 'static')
        b.wrap(attribute.value, () => b.add(JSON.stringify(attribute.text)))
      else
        b.add('(').addSource(attribute.expression).add(')')

      b.add(')}')

      return true
    }

    if (!element.component && attribute.kind === 'expression' && MARKUP_ATTRIBUTES.has(name)) {
      b.addSource(attribute.name).add('={KayHtml((').addSource(attribute.expression).add('))}')

      return true
    }

    if (!element.component || !this.sendsIslandProps || attribute.kind !== 'expression' || name.startsWith('bind:'))
      return false

    // A function never reaches an island, and left unwrapped it takes its parameter types from a generic component's other props.
    if (isFunctionExpression(this.text(attribute.expression))) {
      this.emitFunctionPropCheck(element, attribute.name)
      b.add(' ').addSource(attribute.name).add('={').addSource(attribute.expression).add('}')

      return true
    }

    b.addSource(attribute.name).add('={KayProp(').addSource(element.tag).add(')((').addSource(attribute.expression).add('))}')

    return true
  }

  // A feed or a translation, served by what kay check does not list as pages, or a form posting to a route that may take its method only.
  private servedOtherwise(element: ElementNode): boolean {
    const value = (name: string) => element.attributes.find(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === name)
    const rel = value('rel')
    const method = value('method')

    if (element.name === 'form')
      return method !== undefined && (method.kind !== 'static' || method.text.toLowerCase() !== 'get')

    return element.name === 'link' && rel?.kind === 'static' && rel.text.split(WHITESPACE).includes('alternate')
  }

  // Reports a function passed to an island, `0` standing for the prop.
  private emitFunctionPropCheck(element: ElementNode, name: Span) {
    this.b.add('{...KayFunctionProp(').addSource(element.tag).add(')(').wrap(name, () => this.b.add('0')).add(')}')
  }

  private checkTransition(element: ElementNode, attribute: NamedAttribute) {
    const name = this.text(attribute.name)

    if (name !== 'transition' && !name.startsWith(TRANSITION_PART))
      return

    if (element.component)
      this.error(attribute.name, `\`${name}\` animates an element, not a component`, { help: 'set it on the element the component renders, which a prop can carry' })
    else if (name !== 'transition' && !TRANSITION_PARTS.has(name.slice(TRANSITION_PART.length)))
      this.error(attribute.name, `\`${name}\` is no phase of a transition`, { help: 'use `transition:enter`, `transition:enter-from` or `transition:enter-to`, or the same for `leave`' })
  }

  // `bind:value={name}` reads the signal and writes it back from the matching input event.
  private emitBind(element: ElementNode, attribute: Extract<Attribute, { kind: 'expression' }>, property: string) {
    const { b } = this

    if (element.component || !BINDABLE.has(element.name)) {
      this.error(attribute.name, '`bind:` works on <input>, <textarea> and <select> only', { help: 'pass a component a value and a setter' })

      return
    }

    if (property !== 'value' && property !== 'checked') {
      this.error(attribute.name, `\`bind:${property}\` is not supported`, { help: 'use `bind:value` or `bind:checked`' })

      return
    }

    const inputType = this.staticAttribute(element, 'type') ?? 'text'
    const event = property === 'checked' || element.name === 'select' ? 'onChange' : 'onInput'

    const handler = element.attributes.find(candidate => candidate.kind !== 'spread' && this.text(candidate.name) === event) as NamedAttribute | undefined

    if (handler)
      this.error(attribute.name, `\`bind:${property}\` already handles \`${event}\``, { related: [{ ...handler.name, label: 'handled here too' }], help: 'drop one of them' })

    const read = property === 'checked' ? 'checked' : NUMERIC_INPUTS.has(inputType) ? 'valueAsNumber' : 'value'

    b.wrap(attribute.name, () => b.add(property))
    b.add('={(').addSource(attribute.expression).add(`)()} ${event}={(kayEvent) => `)

    // An emptied number input has no number: the signal keeps its last one rather than take a NaN, or an undefined its type does not allow.
    if (read === 'valueAsNumber')
      b.add('{ const kayValue = kayEvent.currentTarget.valueAsNumber; if (!Number.isNaN(kayValue)) (').addSource(attribute.expression).add(').set(kayValue) }}')
    else
      b.add('(').addSource(attribute.expression).add(`).set(kayEvent.currentTarget.${read})}`)
  }

  private emitText(node: TextNode) {
    const { b } = this

    for (const part of node.parts) {
      if (part.kind === 'element') {
        this.emitElement(part)

        continue
      }

      if (part.kind === 'expression') {
        b.add('{').addSource(part.expression).add('}')

        continue
      }

      const escaped = part.text.replace(JSX_TEXT_ESCAPES, text => `{${JSON.stringify(text)}}`)

      if (escaped === this.text(part))
        b.addSource(part)
      else
        b.wrap(part, () => b.add(escaped))
    }
  }

  private withoutSlots(nodes: Node[]): Node[] {
    const visible: Node[] = []

    for (const node of nodes) {
      if (node.kind === 'slot')
        this.reportSlot(node)
      else
        visible.push(node)
    }

    return visible
  }

  private reportSlot(slot: SlotNode) {
    if (this.options.rewrites)
      return

    this.error(slot, `\`@${this.text(slot.name)}\` must sit directly under a component, to pass it as that component's \`${this.text(slot.name)}\` prop`)
  }

  private text(span: Span): string {
    return this.src.slice(span.start, span.end)
  }

  // Both passes generate the same code, so only the first one reports.
  private error(span: Span, message: string, details?: Details) {
    if (!this.options.rewrites)
      this.diagnostics.push({ start: span.start, end: span.end, message, ...details })
  }

  private lint(span: Span, code: LintName, message: string, details?: Details) {
    if (!this.options.rewrites)
      this.diagnostics.push({ start: span.start, end: span.end, code, message, ...details, checkOnly: true })
  }
}

const INTERACTIVE_ATTRIBUTE = /^(?:on[A-Z]|bind:|ref$)/

// A component needs the browser when it handles events, binds inputs, takes refs or holds reactive state.
export function isInteractive(file: KayFile, script: ScriptAnalysis): boolean {
  return script.reactive || templateFacts(file).interactive
}

// Whether a static component passes a component what may be a function, a class or an instance of one, or a block taking parameters: should that component be an island, it renders as one itself.
export function mayPromote(file: KayFile, script: ScriptAnalysis): boolean {
  const names = new Set([...script.functions, ...script.imports.filter(binding => !binding.typeOnly).map(binding => binding.local)])

  return someNode(file.template, node => node.kind === 'element' && node.component && (node.attributes.some(attribute => (attribute.kind === 'expression' || attribute.kind === 'spread') && mayHoldFunction(file.source.slice(attribute.expression.start, attribute.expression.end), names)) || node.children.some(child => child.kind === 'slot' && child.params !== undefined)))
}

export function templateFacts(file: KayFile): TemplateFacts {
  if (file.facts)
    return file.facts

  const facts: TemplateFacts = { interactive: false, actionForm: false, helpers: new Set(), awaited: new Set(), slot: false, childrenSlot: false, await: false, try: false, classes: [] }
  const text = (span: Span) => file.source.slice(span.start, span.end)

  visitNodes(file.template, (node) => {
    if (node.kind === 'element') {
      facts.interactive ||= node.attributes.some(attribute => attribute.kind !== 'spread' && INTERACTIVE_ATTRIBUTE.test(text(attribute.name)))
      facts.actionForm ||= actionOf(node, file.source) !== undefined
      facts.slot ||= isSlot(node)
      facts.childrenSlot ||= isChildrenSlot(node)
      facts.classes.push(...node.classes.map(text))

      if (mergesComponentClass(node, file.source))
        facts.helpers.add('componentClass')
    }
    else if (node.kind === 'for') {
      facts.helpers.add('For')
    }
    else if (node.kind === 'if' && node.branches.some(branch => branch.alias)) {
      facts.helpers.add('Show')
    }
    else if (node.kind === 'await') {
      const value = text(node.value).trim()

      facts.await = true

      if (IDENTIFIER.test(value))
        facts.awaited.add(value)
    }
    else if (node.kind === 'try') {
      facts.try = true
    }
    else if (node.kind === 'error') {
      facts.classes.push(...node.classes.map(text))
    }
  })

  return file.facts = facts
}

type KayHelper = 'formAction' | 'formValue' | 'formChecked' | 'formInvalid' | 'formError' | 'formProtection' | 'registerActions' | 'actionStub' | 'autoDefer'

function kayAlias(helper: KayHelper): string {
  return `Kay${helper[0]!.toUpperCase()}${helper.slice(1)}`
}

type Helper = TemplateHelper | 'omit'

// The members of `TemplateHelpers` in src/runtime/checks.ts.
type DeclaredHelper = Helper | 'staticFor' | 'Dynamic' | 'head' | 'Try'

function helperAlias(helper: Helper): string {
  return `Kay${helper[0]!.toUpperCase()}${helper.slice(1)}`
}

// A component call whose `class` merges several parts, which it gets as one string: a shorthand with a `class` expression, or a spread next to a shorthand or a `class`.
function mergesComponentClass(element: ElementNode, source: string): boolean {
  if (!element.component)
    return false

  const attribute = element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === 'class')

  if (element.attributes.some(attribute => attribute.kind === 'spread'))
    return element.classes.length > 0 || attribute !== undefined

  return element.classes.length > 0 && attribute?.kind === 'expression'
}

function capitalize(word: string): string {
  return `${word[0]!.toUpperCase()}${word.slice(1)}`
}

// JSX attribute strings have no escapes, so pick a quote the value does not contain, or fall back to an expression.
function quoteAttribute(value: string): string {
  if (!value.includes('"'))
    return `"${value}"`

  if (!value.includes('\''))
    return `'${value}'`

  return `{${JSON.stringify(value)}}`
}

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
