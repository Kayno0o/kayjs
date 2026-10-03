import type { Attribute, AwaitBranch, AwaitNode, Diagnostic, ElementNode, ForNode, IfNode, KayFile, Node, SlotNode, Span, TextNode } from './ast'
import type { Rewrite } from './mapping'
import type { ImportBinding, ScriptAnalysis, ServerAnalysis } from './script'
import { actionUrl } from '../runtime/action'
import { awaitBlocks } from './ast'
import { CodeBuilder, DYNAMIC_TAG } from './mapping'

export interface GenerateOptions {
  name: string
  // Set for an interactive component: its export is wrapped so the server renders it as an island root.
  island?: string
  // Path relative to the project root, naming the module's actions.
  moduleId: string
  // Type-checking output: adds assertions on links, form fields and island props through globals `kay check` declares.
  check?: boolean
  // Browser builds leave the `--- server` fence out entirely; type checking and SSR keep it.
  includeServer?: boolean
  // Route parameters, typing `ctx.params` in `load`.
  params?: string[]
  // `_error.kay`, whose `ctx` carries the error it renders.
  errorPage?: boolean
  // Points a relative import elsewhere, or keeps it when it returns undefined: a shadow file sits deeper than its source.
  relocateImport?: (specifier: string) => string | undefined
  // Final pass: rewrites from the analysis pass are applied and the props destructuring disappears.
  rewrites?: ReadonlyMap<number, Rewrite & { end: number }>
}

export interface Generated {
  builder: CodeBuilder
  // Generated offsets of parameters whose references must be called: loop items, loop indexes, narrowed `if` aliases.
  accessorSites: Set<number>
  diagnostics: Diagnostic[]
}

const JSX_TEXT_ESCAPES = /[{}<>]/g
const BINDABLE = new Set(['input', 'textarea', 'select'])
const NUMERIC_INPUTS = new Set(['number', 'range'])
const FORM_FIELDS = new Set(['input', 'select', 'textarea', 'button'])
const LINK_ELEMENTS = new Set(['a', 'area'])
const CTX_REFERENCE = /\bctx\b/
const LOWERCASE_EVENT = /^on:?([a-z]+)$/
const COMPOUND_EVENT = /^(dbl|key|mouse|pointer|touch|drag|focus|context|before|after)(click|down|up|press|move|enter|leave|over|out|start|end|cancel|in|menu|input)$/
const IMPORT_COMMA_AFTER = /^\s*,\s*/
const IMPORT_COMMA_BEFORE = /,\s*$/
const DEFAULT_PREFIX = '__default_'
const HEAD_TAGS = new Set(['title', 'meta', 'link', 'style', 'script', 'base'])
// The one server export that is no action: `kay build` renders the page once when it is `true`.
const PRERENDER = 'prerender'
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
  private readonly diagnostics: Diagnostic[] = []
  private readonly src: string
  // The action expression of the form being emitted, so its fields' names are checked against the action's input.
  private formTarget: Span | undefined

  constructor(private readonly file: KayFile, private readonly script: ScriptAnalysis, private readonly server: ServerAnalysis | undefined, private readonly options: GenerateOptions) {
    this.src = file.source
    this.b = new CodeBuilder(file.source, options.rewrites)
  }

  run(): Generated {
    const { b, script, server } = this
    const includeServer = server !== undefined && this.options.includeServer !== false

    for (const span of script.hoisted)
      this.emitHoisted(span, script.specifiers, script.imports, [])

    if (includeServer) {
      const duplicates = this.duplicateImports(script, server)

      for (const span of server.hoisted)
        this.emitHoisted(span, server.specifiers, server.imports, duplicates)
    }

    if (server)
      b.add(`import type { ${this.options.errorPage ? 'ErrorPageContext' : 'PageContext'} as KayPageContext, PageData as KayPageData } from 'kay'\n`)

    const kayHelpers = formHelpers(this.file)
    const actions = server?.exportNames.filter(name => name !== PRERENDER) ?? []
    const staticLoops = this.staticLoops
    const used = usedHelpers(this.file.template, script)
    const helpers = used.filter(helper => helper !== 'For' || !staticLoops)

    if (includeServer ? server.exportNames.length > 0 : actions.length > 0)
      kayHelpers.push(includeServer ? 'registerActions' : 'actionStub')

    if (staticLoops && used.includes('For'))
      kayHelpers.push('staticFor')

    if (kayHelpers.length > 0)
      b.add(`import { ${kayHelpers.map(helper => `${helper} as ${kayAlias(helper)}`).join(', ')} } from 'kay'\n`)

    if (server && !includeServer) {
      for (const name of actions)
        b.add(`export const ${name} = KayActionStub(${JSON.stringify(actionUrl(this.options.moduleId, name))})\n`)
    }

    const childrenSlot = usesChildrenSlot(this.file.template)
    const childrenType = ' & { children?: KayJSX.Element }'

    if (childrenSlot)
      b.add(`import type { JSX as KayJSX } from '@solidjs/web'\n`)

    if (helpers.length > 0)
      b.add(`import { ${helpers.map(helper => `${helper} as ${helperAlias(helper)}`).join(', ')} } from 'solid-js'\n`)

    if (this.options.island)
      b.add(`import { island as KayIsland } from 'kay/island'\n`)

    if (usesAwait(this.file.template))
      b.add(`import { Await as KayAwait } from 'kay/await'\n`)

    if (this.options.rewrites && [...this.options.rewrites.values()].some(rewrite => rewrite.dynamic))
      b.add(`import { Dynamic as ${DYNAMIC_TAG} } from '@solidjs/web'\n`)

    const { head, template } = this.splitHead(this.file.template)

    if (head && !this.options.check)
      b.add(`import { useHead as KayUseHead } from '@solidjs/web'\n`)

    if (includeServer)
      this.emitLoad(server)

    b.add(`\n${this.options.island ? '' : 'export default '}function ${this.options.name}(`)

    if (server) {
      b.add(`__props: KayPageData<typeof load>${childrenSlot ? childrenType : ''}`)

      if (script.props)
        this.error(script.props.statement, 'A page gets its data from `--- server`, so it declares no props; read the server names directly')
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

    b.add(') {\n')
    this.emitBody()

    if (head)
      this.emitHead(head)

    b.add('\nreturn ')
    this.emitRoot(template)
    b.add('\n}\n')

    if (this.options.island)
      b.add(`\nexport default KayIsland(${JSON.stringify(this.options.island)}, ${this.options.name})\n`)

    return { builder: b, accessorSites: this.accessorSites, diagnostics: this.diagnostics }
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
        this.error(binding.span, `\`${binding.local}\` is imported twice, once in each fence, and not the same way; import it once`)
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
  private emitLoad(server: ServerAnalysis) {
    const { b } = this

    for (const span of server.exports)
      b.addSource(span).add('\n')

    if (server.exportNames.length > 0)
      b.add(`KayRegisterActions(${JSON.stringify(this.options.moduleId)}, { ${server.exportNames.join(', ')} })\n`)

    const params = this.options.params ? `{ ${this.options.params.map(name => `${JSON.stringify(name)}: string`).join(', ')} }` : 'Record<string, string>'

    // An unused parameter would trip `noUnusedParameters` in the user's tsconfig, so it is named `_ctx` when the fence never reads it.
    const ctx = server.body.some(span => CTX_REFERENCE.test(this.text(span))) ? 'ctx' : '_ctx'

    b.add(`\nexport async function load(${ctx}: KayPageContext<${params}>) {\n`)
    for (const span of server.body)
      b.addSource(span)
    b.add(`\nreturn { ${server.data.map(data => data.name).join(', ')} }\n}\n`)
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

    // A default runs where the prop is read and is typed as the prop, so a function or an object literal in it gets its type from the props type.
    for (const [index, binding] of props.bindings.entries()) {
      if (!binding.fallback)
        continue

      b.wrap(binding.local, () => b.add(`const ${defaultName(index)} = (): Exclude<(typeof __props)[${JSON.stringify(binding.key)}], undefined> => (`))
      b.addSource(binding.fallback).add(');\n')
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

  // The template's top-level `head` block, which renders into the document head rather than in place.
  private splitHead(nodes: Node[]): { head?: ElementNode, template: Node[] } {
    let head: ElementNode | undefined
    const template: Node[] = []

    for (const node of nodes) {
      if (!isHead(node)) {
        template.push(node)

        continue
      }

      if (head)
        this.error(node, 'A template has one `head` block')
      else if (this.options.island)
        this.error(node, 'An island also renders in the browser, so it cannot set the document head; move the `head` block to its page')
      else if (node.attributes.length > 0 || node.classes.length > 0 || node.id)
        this.error(node, 'A `head` block takes no attributes')

      head ??= node
    }

    return { head, template }
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

    b.add('KayUseHead([')
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

  // The tag Solid's `useHead` takes: `{ tag: 'meta', props: { name: 'description', content: (description) } }`.
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

    if (visible.length === 1 && visible[0]!.kind === 'element' && !isChildrenSlot(visible[0]!)) {
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

    for (const node of nodes) {
      switch (node.kind) {
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
        case 'slot':
          this.reportSlot(node)

          break
      }

      previous = node
    }
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

  // Pages and layouts render once on the server and never hydrate, so their loops skip the owner Solid's `For` makes for every row.
  private get staticLoops(): boolean {
    return this.server !== undefined && this.options.includeServer !== false && !this.options.check && !this.options.island
  }

  private emitFor(node: ForNode) {
    const { b } = this
    const tag = helperAlias('For')
    // A key naming the index means rows are matched by position: `for row, i of rows key={i}`.
    const positional = node.index !== undefined && this.text(node.key).trim() === this.text(node.index)

    if (this.staticLoops) {
      this.emitStaticFor(node, positional)

      return
    }

    b.wrap(node, () => {
      b.add(`<${tag} each={`).addSource(node.each).add('} keyed={')

      if (positional)
        b.add('false')
      else
        b.add('(').addSource(node.item).add(') => (').addSource(node.key).add(')')

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
      this.emitRoot(node.children)
      b.add(`}</${tag}>`)
    })
  }

  // The loop's callback takes the same parameters as `For`'s, so the reads the analysis pass rewrote stay right.
  private emitStaticFor(node: ForNode, positional: boolean) {
    const { b } = this

    b.wrap(node, () => {
      b.add(`{${kayAlias('staticFor')}(`).addSource(node.each).add(', (')
      this.accessorSites.add(b.code.length)
      b.addSource(node.item)

      if (node.index) {
        b.add(', ')

        if (!positional)
          this.accessorSites.add(b.code.length)

        b.addSource(node.index)
      }

      b.add(`) => `)
      this.emitRoot(node.children)
      b.add(`, ${positional}`)

      if (node.fallback) {
        b.add(', () => ')
        this.emitRoot(node.fallback)
      }

      b.add(')}')
    })
  }

  private emitElement(element: ElementNode) {
    const { b } = this

    if (isHead(element))
      this.error(element, 'A `head` block sits at the top level of a template')

    if (isChildrenSlot(element)) {
      if (element.attributes.length > 0 || element.classes.length > 0 || element.id || element.children.length > 0)
        this.error(element, '`slot` marks where a layout or wrapper renders its children; it takes no attributes or content')

      b.wrap(element, () => b.add('{__props.children}'))

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

      for (const slot of slots) {
        if (!element.component) {
          this.reportSlot(slot)

          continue
        }

        b.add(' ').addSource(slot.name).add('={')
        this.emitRoot(slot.children)
        b.add('}')
      }
      const children = element.children.filter(child => child.kind !== 'slot')

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

  private emitAttributes(element: ElementNode) {
    const { b } = this

    if (element.id) {
      if (element.attributes.some(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === 'id'))
        this.error(element.id, 'The id is set twice: by `#id` and by an `id` attribute')

      b.add(' id="').addSource(element.id).add('"')
    }

    const classAttributes = element.attributes.filter(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === 'class')

    if (classAttributes.length > 1)
      this.error(classAttributes[1]!.kind === 'spread' ? element : classAttributes[1]!.name, 'An element takes one `class` attribute; put several classes in it')

    // A spread may carry a `class` of its own, which merges in too, so the class goes after every attribute and spread.
    const spreads = element.attributes.some(attribute => attribute.kind === 'spread')

    if (element.classes.length > 0 && !spreads)
      this.emitShorthandClass(element, classAttributes[0])

    for (const attribute of element.attributes) {
      if (element.classes.length > 0 && attribute === classAttributes[0])
        continue

      if (element.component && this.options.island && attribute.kind !== 'spread' && this.text(attribute.name) === 'hydrate')
        this.error(attribute.name, '`hydrate` has no effect inside an island, which hydrates as a whole')

      b.add(' ')

      if (!this.emitFormAttribute(element, attribute))
        this.emitAttribute(element, attribute)
    }

    if (element.classes.length > 0 && spreads)
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

    if (!this.options.check || !this.formTarget || attribute.kind !== 'static' || element.component || !FORM_FIELDS.has(element.name) || this.text(attribute.name) !== 'name')
      return false

    b.addSource(attribute.name).add('={KayField((').addSource(this.formTarget).add('), ')
    b.wrap(attribute.value, () => b.add(JSON.stringify(attribute.text)))
    b.add(')}')

    return true
  }

  private emitShorthandClass(element: ElementNode, attribute: Attribute | undefined) {
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
      b.addSource(attribute.name).add(`={[${JSON.stringify(shorthand)}, (`).addSource(attribute.expression).add(')]}')

      return
    }

    this.error(attribute.kind === 'spread' ? element : attribute.name, '`class` needs a value')
  }

  // The shorthand, the `class` attribute and the `class` each spread brings, in the order they were written.
  private emitMergedClass(element: ElementNode, classAttribute: Attribute | undefined) {
    const { b } = this
    const source = { start: element.classes[0]!.start, end: element.classes.at(-1)!.end }

    b.add(' ')
    b.wrap(classAttribute?.kind === 'expression' ? classAttribute.name : source, () => b.add('class'))
    b.add(`={[${JSON.stringify(element.classes.map(span => this.text(span)).join(' '))}`)

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread') {
        b.add(', ((').addSource(attribute.expression).add(') as unknown as { class?: string }).class')

        continue
      }

      if (attribute !== classAttribute)
        continue

      if (attribute.kind === 'static')
        b.add(`, ${JSON.stringify(attribute.text)}`)
      else if (attribute.kind === 'expression')
        b.add(', (').addSource(attribute.expression).add(')')
      else
        this.error(attribute.name, '`class` needs a value')
    }

    b.add(']}')
  }

  private emitAttribute(element: ElementNode, attribute: Attribute) {
    const { b } = this

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
          this.error(attribute.name, '`bind:` needs a signal: `bind:value={name}`')

        b.addSource(attribute.name)

        return
      case 'static': {
        if (this.text(attribute.name).startsWith('bind:'))
          this.error(attribute.name, '`bind:` needs a signal: `bind:value={name}`')

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

        b.addSource(attribute.name).add('={').addSource(attribute.expression).add('}')
      }
    }
  }

  // `onclick` and `on:click` attach nothing in Solid, and the component would not become an island either.
  private reportLowercaseEvent(attribute: Extract<Attribute, { kind: 'expression' }>) {
    const name = LOWERCASE_EVENT.exec(this.text(attribute.name))?.[1]

    if (name === undefined)
      return

    const camel = name.replace(COMPOUND_EVENT, (_, first: string, second: string) => capitalize(first) + capitalize(second))

    this.error(attribute.name, `\`${this.text(attribute.name)}\` does not attach a handler: events are written in camelCase, as \`on${capitalize(camel)}\``)
  }

  // Check-only wrappers: a site link must match a page, and a static parent passes an island JSON-safe props only.
  private emitCheckedAttribute(element: ElementNode, attribute: Attribute): boolean {
    const { b } = this

    if (attribute.kind === 'spread' || attribute.kind === 'boolean')
      return false

    const name = this.text(attribute.name)

    if (!element.component && LINK_ELEMENTS.has(element.name) && name === 'href') {
      b.addSource(attribute.name).add('={KayHref(')

      if (attribute.kind === 'static')
        b.wrap(attribute.value, () => b.add(JSON.stringify(attribute.text)))
      else
        b.add('(').addSource(attribute.expression).add(')')

      b.add(')}')

      return true
    }

    if (!element.component || this.options.island || attribute.kind !== 'expression' || name.startsWith('bind:'))
      return false

    b.addSource(attribute.name).add('={KayProp(').addSource(element.tag).add(')((').addSource(attribute.expression).add('))}')

    return true
  }

  // `bind:value={name}` reads the signal and writes it back from the matching input event.
  private emitBind(element: ElementNode, attribute: Extract<Attribute, { kind: 'expression' }>, property: string) {
    const { b } = this

    if (element.component || !BINDABLE.has(element.name)) {
      this.error(attribute.name, '`bind:` works on <input>, <textarea> and <select>; pass a value and a setter to components')

      return
    }

    if (property !== 'value' && property !== 'checked') {
      this.error(attribute.name, `\`bind:${property}\` is not supported; use \`bind:value\` or \`bind:checked\``)

      return
    }

    const type = element.attributes.find(candidate => candidate.kind === 'static' && this.text(candidate.name) === 'type')
    const inputType = type?.kind === 'static' ? type.text : 'text'
    const event = property === 'checked' || element.name === 'select' ? 'onChange' : 'onInput'

    if (element.attributes.some(candidate => candidate.kind !== 'spread' && this.text(candidate.name) === event))
      this.error(attribute.name, `\`bind:${property}\` already handles \`${event}\`; drop one of them`)

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

      const escaped = part.text.replace(JSX_TEXT_ESCAPES, char => `{'${char}'}`)

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
  private error(span: Span, message: string) {
    if (!this.options.rewrites)
      this.diagnostics.push({ start: span.start, end: span.end, message })
  }
}

const INTERACTIVE_ATTRIBUTE = /^(?:on[A-Z]|bind:|ref$)/

// A component needs the browser when it handles events, binds inputs, takes refs or holds reactive state.
export function isInteractive(file: KayFile, script: ScriptAnalysis): boolean {
  if (script.reactive)
    return true

  const visit = (nodes: Node[]): boolean => nodes.some((node) => {
    switch (node.kind) {
      case 'element':
        return node.attributes.some(attribute => attribute.kind !== 'spread' && INTERACTIVE_ATTRIBUTE.test(file.source.slice(attribute.name.start, attribute.name.end))) || visit(node.children)
      case 'text':
        return visit(node.parts.filter(part => part.kind === 'element'))
      case 'if':
        return node.branches.some(branch => visit(branch.children))
      case 'for':
        return visit(node.children) || visit(node.fallback ?? [])
      case 'await':
        return awaitBlocks(node).some(visit)
      case 'slot':
        return visit(node.children)
    }

    return false
  })

  return visit(file.template)
}

type KayHelper = 'formAction' | 'registerActions' | 'actionStub' | 'staticFor'

function kayAlias(helper: KayHelper): string {
  return `Kay${helper[0]!.toUpperCase()}${helper.slice(1)}`
}

function actionOf(element: ElementNode, source: string): Extract<Attribute, { kind: 'expression' }> | undefined {
  if (element.component || element.name !== 'form')
    return undefined

  const attribute = element.attributes.find(candidate => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'action')

  return attribute?.kind === 'expression' ? attribute : undefined
}

// The `kay` helpers the template's forms need: `formAction` when a form posts to an action.
function formHelpers(file: KayFile): KayHelper[] {
  const hasActionForm = (nodes: Node[]): boolean => nodes.some((node) => {
    switch (node.kind) {
      case 'element':
        return actionOf(node, file.source) !== undefined || hasActionForm(node.children)
      case 'text':
        return hasActionForm(node.parts.filter(part => part.kind === 'element'))
      case 'if':
        return node.branches.some(branch => hasActionForm(branch.children))
      case 'for':
        return hasActionForm(node.children) || hasActionForm(node.fallback ?? [])
      case 'await':
        return awaitBlocks(node).some(hasActionForm)
      case 'slot':
        return hasActionForm(node.children)
    }

    return false
  })

  return hasActionForm(file.template) ? ['formAction'] : []
}

type Helper = 'For' | 'Show' | 'omit'

function helperAlias(helper: Helper): string {
  return `Kay${helper[0]!.toUpperCase()}${helper.slice(1)}`
}

function isHead(node: Node): node is ElementNode {
  return node.kind === 'element' && !node.component && node.name === 'head'
}

// `slot` renders the children a layout or wrapper component receives, like Astro's `<slot />`.
function isChildrenSlot(node: Node): boolean {
  return node.kind === 'element' && node.name === 'slot' && !node.component
}

function usesChildrenSlot(nodes: Node[]): boolean {
  return nodes.some((node) => {
    if (isChildrenSlot(node))
      return true

    switch (node.kind) {
      case 'element':
      case 'slot':
        return usesChildrenSlot(node.children)
      case 'text':
        return usesChildrenSlot(node.parts.filter(part => part.kind === 'element'))
      case 'if':
        return node.branches.some(branch => usesChildrenSlot(branch.children))
      case 'for':
        return usesChildrenSlot(node.children) || usesChildrenSlot(node.fallback ?? [])
      case 'await':
        return awaitBlocks(node).some(usesChildrenSlot)
    }

    return false
  })
}

function usesAwait(nodes: Node[]): boolean {
  return nodes.some((node) => {
    switch (node.kind) {
      case 'await':
        return true
      case 'element':
      case 'slot':
        return usesAwait(node.children)
      case 'text':
        return usesAwait(node.parts.filter(part => part.kind === 'element'))
      case 'if':
        return node.branches.some(branch => usesAwait(branch.children))
      case 'for':
        return usesAwait(node.children) || usesAwait(node.fallback ?? [])
    }

    return false
  })
}

function usedHelpers(nodes: Node[], script: ScriptAnalysis): Helper[] {
  const used = new Set<Helper>()

  if (script.props?.rest)
    used.add('omit')

  const visit = (list: Node[]) => {
    for (const node of list) {
      if (node.kind === 'for') {
        used.add('For')
        visit(node.children)
        visit(node.fallback ?? [])
      }
      else if (node.kind === 'if') {
        for (const branch of node.branches) {
          if (branch.alias)
            used.add('Show')

          visit(branch.children)
        }
      }
      else if (node.kind === 'element' || node.kind === 'slot') {
        visit(node.children)
      }
      else if (node.kind === 'await') {
        for (const block of awaitBlocks(node))
          visit(block)
      }
      else {
        visit(node.parts.filter(part => part.kind === 'element'))
      }
    }
  }

  visit(nodes)

  return [...used]
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
