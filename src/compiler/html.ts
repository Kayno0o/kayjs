import type { Attribute, AwaitNode, ElementNode, ForNode, IfNode, NamedAttribute, Node, SlotNode, Span, TextNode } from './ast'
import type { CodeBuilder } from './mapping'
import { parseExpression } from '@babel/parser'
import { actionOf, isChildrenSlot, isHead } from './ast'

// The `kay/html` helpers static server output calls, each imported under a `Kay` name.
const HTML_HELPERS = ['attribute', 'child', 'className', 'dynamic', 'element', 'head', 'loop', 'merge', 'omit', 'raw', 'selectOptions', 'show', 'style']

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'menuitem', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW_ELEMENTS = new Set(['script', 'style'])
// Properties that set an element's content rather than an attribute.
const CONTENT_PROPERTIES = new Set(['innerHTML', 'textContent', 'innerText', 'children'])
// Handlers, refs and bindings, which only an island attaches; `open` is the one attribute starting with `on` that is none.
const BEHAVIOUR = /^(?:on(?!en$)|ref$|bind:|prop:)/
const LESS_THAN = /</g
const STATIC_ATTRIBUTE = /["<]|&(?!(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);)/gi
const ATTRIBUTE_ENTITY: Record<string, string> = { '"': '&quot;', '<': '&lt;', '&': '&amp;' }

export function htmlHelperImport(): string {
  return `import { ${HTML_HELPERS.map(helper => `${helper} as ${htmlAlias(helper)}`).join(', ')} } from 'kay/html'\n`
}

function htmlAlias(helper: string): string {
  return `Kay${helper[0]!.toUpperCase()}${helper.slice(1)}`
}

// Static text written as markup: `& b` and `&amp;` both stay as written, the way JSX text reaches the server markup.
function escapeText(text: string): string {
  return text.replace(LESS_THAN, '&lt;')
}

// A quoted attribute as JSX reads it, an entity standing for its character, then escaped for markup.
function escapeStaticAttribute(text: string): string {
  return text.replace(STATIC_ATTRIBUTE, char => ATTRIBUTE_ENTITY[char] ?? '&amp;')
}

// The string a JSX attribute or text spells, its entities decoded, as a component receives it.
function decodeEntities(text: string): string {
  if (!text.includes('&'))
    return text

  try {
    const expression = parseExpression(`<a b="${text.replaceAll('"', '&quot;')}" />`, { plugins: ['jsx'] })

    if (expression.type === 'JSXElement') {
      const value = expression.openingElement.attributes[0]

      if (value?.type === 'JSXAttribute' && value.value?.type === 'StringLiteral')
        return value.value.value
    }
  }
  catch {}

  return text
}

// Static parts gather into one string literal; each dynamic part is an expression of the markup it renders.
class Markup {
  private pending = ''
  private parts = 0

  constructor(private readonly b: CodeBuilder) {}

  text(text: string): void {
    this.pending += text
  }

  dynamic(emit: () => void): void {
    this.flush()
    this.separate()
    emit()
  }

  end(): void {
    this.flush()

    if (this.parts === 0)
      this.b.add('""')
  }

  private flush(): void {
    if (this.pending === '')
      return

    this.separate()
    this.b.add(JSON.stringify(this.pending))
    this.pending = ''
  }

  private separate(): void {
    if (this.parts++ > 0)
      this.b.add(' + ')
  }
}

// A template as code building its markup: what pages, layouts and static components render to outside islands, with no reactive runtime.
export class HtmlTemplate {
  constructor(private readonly b: CodeBuilder, private readonly src: string) {}

  // The nodes' markup as one string expression.
  markup(nodes: Node[]): void {
    const markup = new Markup(this.b)

    this.b.add('(')
    this.children(nodes, markup, false)
    markup.end()
    this.b.add(')')
  }

  // A rendered value, which a component returns and a prop carries.
  value(nodes: Node[]): void {
    this.b.add('({ t: ')
    this.markup(nodes)
    this.b.add(' })')
  }

  private children(nodes: Node[], markup: Markup, raw: boolean): void {
    let previous: Node | undefined

    for (const node of nodes) {
      switch (node.kind) {
        case 'element':
          this.element(node, markup)

          break
        case 'text':
          if (previous?.kind === 'text')
            markup.text('\n')

          this.text(node, markup, raw)

          break
        case 'if':
          markup.dynamic(() => this.b.wrap(node, () => this.if(node, 0)))

          break
        case 'for':
          markup.dynamic(() => this.for(node))

          break
        case 'await':
          markup.dynamic(() => this.await(node))

          break
        case 'slot':
          break
      }

      previous = node
    }
  }

  private text(node: TextNode, markup: Markup, raw: boolean): void {
    for (const part of node.parts) {
      if (part.kind === 'element')
        this.element(part, markup)
      else if (part.kind === 'expression')
        markup.dynamic(() => this.b.add(`${htmlAlias(raw ? 'raw' : 'child')}((`).addSource(part.expression).add('))'))
      else
        markup.text(raw ? part.text : escapeText(part.text))
    }
  }

  private if(node: IfNode, index: number): void {
    const { b } = this
    const branch = node.branches[index]!

    b.wrap(branch, () => {
      if (!branch.test) {
        this.markup(branch.children)

        return
      }

      const hasRest = index + 1 < node.branches.length

      // The branch reads a named value through a function, as the island build of the same template does.
      if (branch.alias) {
        b.add(`${htmlAlias('show')}((`).addSource(branch.test).add('), (').addSource(branch.alias).add(') => ')
        this.markup(branch.children)

        if (hasRest) {
          b.add(', () => ')
          this.if(node, index + 1)
        }

        b.add(')')

        return
      }

      b.add('((').addSource(branch.test).add(') ? ')
      this.markup(branch.children)
      b.add(' : ')

      if (hasRest)
        this.if(node, index + 1)
      else
        b.add('""')

      b.add(')')
    })
  }

  private for(node: ForNode): void {
    const { b } = this

    b.wrap(node, () => {
      b.add(`${htmlAlias('loop')}((`).addSource(node.each).add('), (').addSource(node.item)

      if (node.index)
        b.add(', ').addSource(node.index)

      b.add(') => ')
      this.markup(node.children)

      if (node.fallback) {
        b.add(', () => ')
        this.markup(node.fallback)
      }

      b.add(')')
    })
  }

  private await(node: AwaitNode): void {
    const { b } = this

    b.wrap(node, () => {
      b.add(`${htmlAlias('child')}(KayAwait({ `)
      b.wrap(node.value, () => b.add('value'))
      b.add(': (').addSource(node.value).add(')')

      if (node.pending.length > 0) {
        b.add(', pending: () => ')
        this.value(node.pending)
      }

      for (const [prop, branch] of [['ready', node.resolved], ['failed', node.rejected]] as const) {
        if (!branch)
          continue

        b.wrap(branch, () => {
          b.add(`, ${prop}: (`)

          if (branch.alias)
            b.addSource(branch.alias)

          b.add(') => ')
          this.value(branch.children)
        })
      }

      b.add(' }))')
    })
  }

  private element(element: ElementNode, markup: Markup): void {
    const { b } = this

    if (isHead(element))
      return

    if (isChildrenSlot(element)) {
      markup.dynamic(() => b.wrap(element, () => b.add(`${htmlAlias('child')}(__props.children)`)))

      return
    }

    if (element.component) {
      markup.dynamic(() => b.wrap(element, () => this.component(element)))

      return
    }

    if (element.attributes.some(attribute => attribute.kind === 'spread')) {
      markup.dynamic(() => b.wrap(element, () => this.spreadElement(element)))

      return
    }

    this.plainElement(element, markup)
  }

  private plainElement(element: ElementNode, markup: Markup): void {
    const { b } = this
    const name = element.name
    const classAttribute = this.classAttribute(element)
    const children = element.children.filter(child => child.kind !== 'slot')
    let content: Span | undefined
    let rawContent = false
    let selected: Span | undefined

    markup.text(`<${name}`)

    if (element.id)
      markup.text(` id="${escapeStaticAttribute(this.source(element.id))}"`)

    if (element.classes.length > 0) {
      const shorthand = this.shorthand(element)

      if (classAttribute?.kind === 'expression') {
        markup.text(' class="')
        markup.dynamic(() => b.add(`${htmlAlias('className')}([${JSON.stringify(shorthand)}, (`).addSource(classAttribute.expression).add(')])'))
        markup.text('"')
      }
      else {
        markup.text(` class="${escapeStaticAttribute(classAttribute?.kind === 'static' ? `${shorthand} ${decodeEntities(classAttribute.text)}` : shorthand)}"`)
      }
    }

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread' || (element.classes.length > 0 && attribute === classAttribute))
        continue

      const attributeName = this.source(attribute.name)

      if (BEHAVIOUR.test(attributeName))
        continue

      if (attribute.kind === 'boolean') {
        markup.text(` ${attributeName}`)

        continue
      }

      if (attribute.kind === 'static') {
        if (CONTENT_PROPERTIES.has(attributeName) || (name === 'textarea' && attributeName === 'value'))
          continue

        markup.text(attribute.text === '' ? ` ${attributeName}` : ` ${attributeName}="${escapeStaticAttribute(decodeEntities(attribute.text))}"`)

        continue
      }

      const expression = attribute.expression

      if (CONTENT_PROPERTIES.has(attributeName) || (name === 'textarea' && (attributeName === 'value' || attributeName === 'defaultValue'))) {
        content = expression
        rawContent = attributeName === 'innerHTML' || RAW_ELEMENTS.has(name)

        continue
      }

      if (name === 'select' && attributeName === 'value')
        selected = expression

      if (attributeName === 'class' || attributeName === 'style') {
        markup.text(` ${attributeName}="`)
        markup.dynamic(() => b.add(`${htmlAlias(attributeName === 'class' ? 'className' : 'style')}((`).addSource(expression).add('))'))
        markup.text('"')

        continue
      }

      markup.dynamic(() => {
        b.add(`${htmlAlias('attribute')}(${JSON.stringify(attributeName)}, `)

        if (attribute === actionOf(element, this.src))
          b.add('KayFormAction((').addSource(expression).add('))')
        else
          b.add('(').addSource(expression).add(')')

        b.add(')')
      })
    }

    if (actionOf(element, this.src)) {
      if (!this.named(element, 'method'))
        markup.text(' method="post"')

      // Multipart whatever the schema, so file inputs post too; Elysia parses either encoding alike.
      if (!this.named(element, 'enctype'))
        markup.text(' enctype="multipart/form-data"')
    }

    markup.text('>')

    if (VOID_ELEMENTS.has(name))
      return

    if (children.length > 0 && selected) {
      markup.dynamic(() => {
        b.add(`${htmlAlias('selectOptions')}((`).addSource(selected).add('), ')
        this.markup(children)
        b.add(')')
      })
    }
    else if (children.length > 0) {
      this.children(children, markup, RAW_ELEMENTS.has(name))
    }
    else if (content) {
      markup.dynamic(() => b.add(`${htmlAlias(rawContent ? 'raw' : 'child')}((`).addSource(content).add('))'))
    }

    markup.text(`</${name}>`)
  }

  // An element with a spread renders through `element`, which reads every attribute the spread brings at render time.
  private spreadElement(element: ElementNode): void {
    const { b } = this
    const children = element.children.filter(child => child.kind !== 'slot')

    b.add(`${htmlAlias('element')}(${JSON.stringify(element.name)}, [`)
    this.sources(element, (attribute, emit) => {
      if (attribute === actionOf(element, this.src))
        b.add('KayFormAction((').addSource(attribute.expression).add('))')
      else
        emit()
    })

    if (actionOf(element, this.src)) {
      const defaults = [['method', 'post'], ['enctype', 'multipart/form-data']].filter(([name]) => !this.named(element, name!))

      if (defaults.length > 0)
        b.add(`, { ${defaults.map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`).join(', ')} }`)
    }

    b.add(']')

    if (children.length > 0) {
      b.add(', () => ')
      this.markup(children)
    }

    b.add(').t')
  }

  private component(element: ElementNode): void {
    const { b } = this
    const dynamic = b.isDynamicTag(element.tag)

    b.add(`${htmlAlias('child')}(`)

    if (dynamic)
      b.add(`${htmlAlias('dynamic')}(`).addSource(element.tag).add(', ')
    else
      b.addSource(element.tag).add('(')

    const spreads = element.attributes.some(attribute => attribute.kind === 'spread')

    if (spreads)
      b.add(`${htmlAlias('merge')}(`)

    const closing = this.sources(element, (_, emit) => emit(), true)

    for (const slot of element.children.filter((child): child is SlotNode => child.kind === 'slot')) {
      closing.separate()

      if (slot.params) {
        b.add(`${JSON.stringify(this.source(slot.name))}: (`).addSource(slot.params).add(') => ')
        this.childrenValue(slot.children)
      }
      else {
        b.add(`get ${JSON.stringify(this.source(slot.name))}() { return `)
        this.childrenValue(slot.children)
        b.add(' }')
      }
    }

    const children = element.children.filter(child => child.kind !== 'slot')

    if (children.length > 0) {
      closing.separate()
      b.add('get children() { return ')
      this.childrenValue(children)
      b.add(' }')
    }

    closing.close()

    if (spreads)
      b.add(')')

    b.add('))')
  }

  // The attributes as props objects, spreads between them in the order written; the class a shorthand, an attribute and the spreads each bring merges last.
  // Returns the last object, still open, for a component to add its children and slots to.
  private sources(element: ElementNode, value: (attribute: Extract<Attribute, { kind: 'expression' }>, emit: () => void) => void, keepOpen = false): { separate: () => void, close: () => void } {
    const { b } = this
    const classAttribute = this.classAttribute(element)
    const spreads = element.attributes.some(attribute => attribute.kind === 'spread')
    const mergedClass = element.classes.length > 0 || (spreads && classAttribute !== undefined)
    let open = false
    let entries = 0
    let objects = 0

    const separate = () => {
      if (!open) {
        b.add(objects++ > 0 ? ', { ' : '{ ')
        open = true
        entries = 0
      }

      if (entries++ > 0)
        b.add(', ')
    }

    const closeObject = () => {
      if (open)
        b.add(' }')

      open = false
    }

    const close = () => {
      if (!open && objects === 0)
        b.add('{}')

      closeObject()
    }

    if (element.id) {
      separate()
      b.add(`"id": ${JSON.stringify(this.source(element.id))}`)
    }

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread') {
        closeObject()
        b.add(objects++ > 0 ? ', (' : '(').addSource(attribute.expression).add(')')

        continue
      }

      if (mergedClass && attribute === classAttribute)
        continue

      const name = this.source(attribute.name)

      if (!element.component && BEHAVIOUR.test(name))
        continue

      separate()
      b.add(`${JSON.stringify(name)}: `)

      if (attribute.kind === 'boolean')
        b.add('true')
      else if (attribute.kind === 'static')
        b.add(JSON.stringify(decodeEntities(attribute.text)))
      else
        value(attribute, () => b.add('(').addSource(attribute.expression).add(')'))
    }

    if (mergedClass) {
      separate()
      this.mergedClass(element, classAttribute, spreads)
    }

    if (!keepOpen)
      close()

    return { separate, close }
  }

  // `class` as written: the shorthand alone or merged with a static attribute is a string; with an expression or spreads, an array of every source.
  private mergedClass(element: ElementNode, classAttribute: NamedAttribute | undefined, spreads: boolean): void {
    const { b } = this
    const shorthand = element.classes.length > 0 ? this.shorthand(element) : undefined

    b.add('"class": ')

    if (!spreads && classAttribute?.kind !== 'expression') {
      b.add(JSON.stringify(classAttribute?.kind === 'static' ? `${shorthand} ${decodeEntities(classAttribute.text)}` : shorthand))

      return
    }

    const items: (() => void)[] = []

    if (shorthand !== undefined)
      items.push(() => b.add(JSON.stringify(shorthand)))

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread')
        items.push(() => b.add('((').addSource(attribute.expression).add(') as unknown as { class?: string }).class'))
      else if (attribute === classAttribute && attribute.kind === 'static')
        items.push(() => b.add(JSON.stringify(decodeEntities(attribute.text))))
      else if (attribute === classAttribute && attribute.kind === 'expression')
        items.push(() => b.add('(').addSource(attribute.expression).add(')'))
    }

    b.add('[')
    for (const [index, item] of items.entries()) {
      if (index > 0)
        b.add(', ')

      item()
    }
    b.add(']')
  }

  // What a component receives as `children` or a slot: a lone line of text as its string or values, as JSX passes it, anything else as rendered markup.
  private childrenValue(nodes: Node[]): void {
    const { b } = this
    const lone = nodes.length === 1 && nodes[0]!.kind === 'text' ? nodes[0] : undefined

    if (!lone || lone.parts.some(part => part.kind === 'element')) {
      this.value(nodes)

      return
    }

    const parts = lone.parts as Exclude<TextNode['parts'][number], ElementNode>[]

    if (parts.length > 1)
      b.add('[')

    for (const [index, part] of parts.entries()) {
      if (index > 0)
        b.add(', ')

      if (part.kind === 'expression')
        b.add('(').addSource(part.expression).add(')')
      else
        b.add(JSON.stringify(decodeEntities(part.text)))
    }

    if (parts.length > 1)
      b.add(']')
  }

  private classAttribute(element: ElementNode): NamedAttribute | undefined {
    return element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && this.source(attribute.name) === 'class')
  }

  private shorthand(element: ElementNode): string {
    return element.classes.map(span => this.source(span)).join(' ')
  }

  private named(element: ElementNode, name: string): boolean {
    return element.attributes.some(attribute => attribute.kind !== 'spread' && this.source(attribute.name) === name)
  }

  private source(span: Span): string {
    return this.src.slice(span.start, span.end)
  }
}
