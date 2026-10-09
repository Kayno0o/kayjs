import type { Attribute, AwaitNode, ElementNode, ErrorMessages, ForNode, IfNode, NamedAttribute, Node, SlotNode, Span, TextNode, TryNode } from './ast'
import type { DynamicItem } from './items'
import type { CodeBuilder } from './mapping'
import { actionOf, describedByOf, formFieldOf } from './ast'
import { decodeEntities, isFunctionExpression } from './expression'
import { BEHAVIOUR, CONTENT_PROPERTIES, describedValue, END_MARKER, escapeStaticAttribute, escapeText, RAW_ELEMENTS, START_MARKER, VOID_ELEMENTS } from './html'
import { childItems, soleDynamic } from './items'

// The `kay/dom` helpers browser output calls, each imported under a `Kay` name.
const DOM_HELPERS = ['append', 'attempt', 'attribute', 'awaited', 'branches', 'close', 'component', 'componentClass', 'dynamic', 'effect', 'fragment', 'image', 'insert', 'listen', 'loop', 'markers', 'merge', 'omit', 'property', 'ref', 'rowKey', 'setClass', 'setStyle', 'spread', 'template', 'text', 'transition']
const NUMERIC_INPUTS = new Set(['number', 'range'])
const TRANSITION_PART = 'transition:'

export function domHelperImport(): string {
  return `import { ${DOM_HELPERS.map(helper => `${helper} as ${domAlias(helper)}`).join(', ')} } from 'kay/dom'\n`
}

function domAlias(helper: string): string {
  return `Kay${helper[0]!.toUpperCase()}${helper.slice(1)}`
}

// A node of a template, so the code can reach the ones it binds: through `firstChild` and `nextSibling`, and past a dynamic part through its end marker.
interface TemplateNode {
  kind: 'element' | 'text' | 'start' | 'end'
  parent?: TemplateNode
  previous?: TemplateNode
  last?: TemplateNode
  variable?: string
}

// What the code does with a template's nodes once it holds the root, in document order, an element's own bindings after its content's.
type Binding = (variable: (node: TemplateNode) => string) => void

// A template as code building its DOM in the browser, or claiming the server's markup of it when an island hydrates.
export class DomTemplate {
  private readonly templates: string[] = []
  private counter = 0
  // The action the form being emitted posts to, whose refusal marks its fields invalid.
  private formTarget: Span | undefined

  // `errors`: what a refused form's fields are described by.
  constructor(private readonly b: CodeBuilder, private readonly src: string, private readonly errors?: ErrorMessages) {}

  // A block: one element, or a fragment of its items, or `null` when empty.
  block(nodes: Node[]): void {
    const items = childItems(nodes)
    const [only] = items

    if (!only)
      this.b.add('null')
    else if (items.length === 1 && only.kind === 'element')
      this.element(only.node)
    else
      this.fragment(nodes)
  }

  // The module-level templates the code clones, declared after the components that use them.
  declarations(): string {
    return this.templates.map((html, index) => `const KayT${index} = KayTemplate(${JSON.stringify(html)})\n`).join('')
  }

  private fragment(nodes: Node[]): void {
    const { b } = this
    const parent = `KayP${this.counter++}`

    b.add(`KayFragment((${parent}) => { `)

    for (const item of childItems(nodes)) {
      if (item.kind === 'text') {
        b.add(`KayText(${parent}, ${JSON.stringify(decodeEntities(item.text))}); `)
      }
      else if (item.kind === 'element') {
        b.add(`KayAppend(${parent}, `)
        this.element(item.node)
        b.add('); ')
      }
      else {
        b.add(`{ const [KayS, KayE] = KayMarkers(${parent}); `)
        this.dynamic(item, 'null', 'KayS', 'KayE')
        b.add(' } ')
      }
    }

    b.add('})')
  }

  // A dynamic part rendered into an element's content, or between two markers.
  private dynamic(item: DynamicItem, element: string, start: string, end: string): void {
    const { b } = this
    const at = `${element}, ${start}, ${end}`

    switch (item.kind) {
      case 'expression':
        b.add(`KayInsert(${at}, () => (`).addSource(item.node.expression).add('));')

        break
      case 'component':
        b.wrap(item.node, () => {
          b.add(`KayInsert(${at}, () => `)
          this.component(item.node)
          b.add(', false);')
        })

        break
      case 'slot':
        b.wrap(item.node, () => b.add(`KayInsert(${at}, () => __props.children);`))

        break
      case 'if':
        b.wrap(item.node, () => this.if(item.node, at))

        break
      case 'for':
        b.wrap(item.node, () => this.for(item.node, at))

        break
      case 'await':
        b.wrap(item.node, () => this.await(item.node, at))

        break
      case 'try':
        b.wrap(item.node, () => this.try(item.node, at))

        break
    }
  }

  private if(node: IfNode, at: string): void {
    const { b } = this

    b.add(`KayBranches(${at}, [`)

    for (const branch of node.branches) {
      b.wrap(branch, () => {
        b.add('[')

        if (branch.test)
          b.add('() => (').addSource(branch.test).add(')')
        else
          b.add('null')

        b.add(', (')

        if (branch.alias)
          b.addSource(branch.alias)

        b.add(') => ')
        this.block(branch.children)
        b.add('], ')
      })
    }

    b.add(']);')
  }

  private for(node: ForNode, at: string): void {
    const { b } = this
    // A key naming the index means rows are matched by position: `for row, i of rows key={i}`.
    const positional = node.index !== undefined && node.key !== undefined && this.source(node.key).trim() === this.source(node.index)

    b.add(`KayLoop(${at}, () => (`).addSource(node.each).add('), ')

    if (positional)
      b.add('false')
    else if (node.key)
      b.add('(').addSource(node.item).add(') => (').addSource(node.key).add(')')
    else
      b.add(domAlias('rowKey'))

    b.add(', (').addSource(node.item)

    if (node.index)
      b.add(', ').addSource(node.index)

    b.add(') => ')
    this.block(node.children)

    if (node.fallback) {
      b.add(', () => ')
      this.block(node.fallback)
    }

    b.add(');')
  }

  private try(node: TryNode, at: string): void {
    const { b } = this
    const branch = node.rejected

    b.add(`KayAttempt(${at}, () => `)
    this.block(node.children)
    b.add(', ')

    if (branch) {
      b.wrap(branch, () => {
        b.add('(')

        if (branch.alias)
          b.addSource(branch.alias)

        b.add(') => ')
        this.block(branch.children)
      })
    }
    else {
      b.add('undefined')
    }

    b.add(');')
  }

  private await(node: AwaitNode, at: string): void {
    const { b } = this

    b.add(`KayAwaited(${at}, () => (`).addSource(node.value).add('), ')

    if (node.pending.length > 0) {
      b.add('() => ')
      this.block(node.pending)
    }
    else {
      b.add('undefined')
    }

    for (const branch of [node.resolved, node.rejected]) {
      b.add(', ')

      if (!branch) {
        b.add(branch === node.resolved ? '() => null' : 'undefined')

        continue
      }

      b.wrap(branch, () => {
        b.add('(')

        if (branch.alias)
          b.addSource(branch.alias)

        b.add(') => ')
        this.block(branch.children)
      })
    }

    b.add(');')
  }

  // An element built from a template, its dynamic attributes, handlers and parts bound once the root is in hand.
  private element(element: ElementNode): void {
    const { b } = this
    const bindings: Binding[] = []
    const root: TemplateNode = { kind: 'element' }
    const html = this.templateOf(element, root, bindings)
    const index = this.templates.push(html) - 1

    if (bindings.length === 0) {
      b.add(`KayT${index}()`)

      return
    }

    const prefix = `KayN${this.counter++}_`
    let next = 0

    root.variable = `${prefix}${next++}`
    b.add(`(() => { const ${root.variable} = KayT${index}(); `)

    const variable = (node: TemplateNode): string => {
      if (node.variable !== undefined)
        return node.variable

      let access: string

      if (node.kind === 'end')
        access = `KayClose(${variable(node.previous!)})`
      else if (node.previous)
        access = `${variable(node.previous)}.nextSibling`
      else
        access = `${variable(node.parent!)}.firstChild`

      node.variable = `${prefix}${next++}`
      b.add(`const ${node.variable} = ${access}; `)

      return node.variable
    }

    for (const binding of bindings) {
      binding(variable)
      b.add(' ')
    }

    b.add(`return ${root.variable} })()`)
  }

  private child(parent: TemplateNode, kind: TemplateNode['kind']): TemplateNode {
    const node: TemplateNode = { kind, parent, previous: parent.last }

    parent.last = node

    return node
  }

  // The element's markup for the template, with what the code binds collected along the way.
  private templateOf(element: ElementNode, node: TemplateNode, bindings: Binding[]): string {
    const { b } = this
    const name = element.name
    const spreads = element.attributes.some(attribute => attribute.kind === 'spread')
    const children = element.children.filter(child => child.kind !== 'slot')
    const own: Binding[] = []
    let html = `<${name}`
    let content: string | undefined
    let contentBinding: Binding | undefined
    let selected: Span | undefined

    if (spreads) {
      own.push(variable => this.spreadBinding(element, variable(node), children.length === 0))
    }
    else {
      const errorId = this.errors?.ids.get(element)

      if (element.id)
        html += ` id="${escapeStaticAttribute(this.source(element.id))}"`
      else if (errorId !== undefined)
        html += ` id="${escapeStaticAttribute(errorId)}"`

      const classAttribute = this.classAttribute(element)
      const imageSizes = this.imageSizes(element)

      if (element.classes.length > 0) {
        const shorthand = this.shorthand(element)

        if (classAttribute?.kind === 'expression')
          own.push(variable => b.add(`KayEffect(() => KaySetClass(${variable(node)}, [${JSON.stringify(shorthand)}, (`).addSource(classAttribute.expression).add(')]));'))
        else
          html += ` class="${escapeStaticAttribute(classAttribute?.kind === 'static' ? `${shorthand} ${decodeEntities(classAttribute.text)}` : shorthand)}"`
      }

      for (const attribute of element.attributes) {
        if (attribute.kind === 'spread' || (element.classes.length > 0 && attribute === classAttribute) || attribute === imageSizes)
          continue

        const attributeName = this.source(attribute.name)

        if (BEHAVIOUR.test(attributeName)) {
          const binding = this.behaviour(element, attribute, attributeName, node)

          if (binding)
            own.push(binding)

          continue
        }

        if (attribute.kind === 'boolean') {
          html += ` ${attributeName}`

          continue
        }

        if (attribute.kind === 'static') {
          if (attributeName === 'innerHTML')
            content = attribute.text
          else if (CONTENT_PROPERTIES.has(attributeName) || (name === 'textarea' && attributeName === 'value'))
            content = escapeText(decodeEntities(attribute.text))
          else
            html += attribute.text === '' ? ` ${attributeName}` : ` ${attributeName}="${escapeStaticAttribute(decodeEntities(attribute.text))}"`

          continue
        }

        const expression = attribute.expression

        if (CONTENT_PROPERTIES.has(attributeName) || (name === 'textarea' && (attributeName === 'value' || attributeName === 'defaultValue'))) {
          const property = attributeName === 'defaultValue' || attributeName === 'value' ? 'value' : attributeName

          contentBinding = variable => b.add(`KayEffect(() => KayProperty(${variable(node)}, ${JSON.stringify(property)}, (`).addSource(expression).add(')));')

          continue
        }

        if (name === 'select' && attributeName === 'value') {
          selected = expression

          continue
        }

        if (attributeName === 'class' || attributeName === 'style') {
          own.push(variable => b.add(`KayEffect(() => ${attributeName === 'class' ? 'KaySetClass' : 'KaySetStyle'}(${variable(node)}, (`).addSource(expression).add(')));'))

          continue
        }

        if (name === 'img' && attributeName === 'src' && !this.named(element, 'srcset')) {
          const sized = this.named(element, 'width') || this.named(element, 'height')

          own.push((variable) => {
            b.add(`KayEffect(() => KayImage(${variable(node)}, (`).addSource(expression).add(`), ${sized}`)
            this.sizesArgument(imageSizes)
            b.add('));')
          })

          continue
        }

        own.push((variable) => {
          b.add(`KayEffect(() => KayProperty(${variable(node)}, ${JSON.stringify(attributeName)}, `)

          if (attribute === actionOf(element, this.src))
            b.add('KayFormAction((').addSource(expression).add('))')
          else
            b.add('(').addSource(expression).add(')')

          b.add('));')
        })
      }

      const action = actionOf(element, this.src)

      if (action) {
        if (!this.named(element, 'method'))
          html += ' method="post"'

        if (!this.named(element, 'enctype'))
          html += ' enctype="multipart/form-data"'

        const described = describedByOf(element, this.src, this.errors, action.expression, '')

        if (described)
          own.push(variable => b.add(`KayEffect(() => KayProperty(${variable(node)}, "aria-describedby", KayFormInvalid((`).addSource(action.expression).add(`), ""${describedValue(described)}));`))
      }
    }

    const field = this.formTarget && !spreads ? formFieldOf(element, this.src) : undefined

    if (field?.invalid) {
      const target = this.formTarget!

      own.push(variable => b.add(`KayEffect(() => KayProperty(${variable(node)}, "aria-invalid", KayFormInvalid((`).addSource(target).add(`), ${JSON.stringify(field.name)})));`))

      const described = describedByOf(element, this.src, this.errors, target, field.name)

      if (described)
        own.push(variable => b.add(`KayEffect(() => KayProperty(${variable(node)}, "aria-describedby", KayFormInvalid((`).addSource(target).add(`), ${JSON.stringify(field.name)}${describedValue(described)}));`))
    }

    html += '>'

    if (VOID_ELEMENTS.has(name)) {
      bindings.push(...own)

      return html
    }

    const outerTarget = this.formTarget

    this.formTarget = actionOf(element, this.src)?.expression ?? outerTarget

    const target = this.formTarget

    if (children.length > 0) {
      const items = childItems(children)
      const raw = RAW_ELEMENTS.has(name)
      const sole = soleDynamic(items)

      for (const item of items) {
        if (item.kind === 'text') {
          this.child(node, 'text')
          html += raw ? item.text : escapeText(item.text)
        }
        else if (item.kind === 'element') {
          html += this.templateOf(item.node, this.child(node, 'element'), bindings)
        }
        else if (sole) {
          bindings.push(variable => this.inForm(target, () => this.dynamic(item, variable(node), 'null', 'null')))
        }
        else {
          const start = this.child(node, 'start')
          const end = this.child(node, 'end')

          html += START_MARKER + END_MARKER
          bindings.push(variable => this.inForm(target, () => this.dynamic(item, 'null', variable(start), variable(end))))
        }
      }
    }
    else if (content !== undefined) {
      html += content
    }
    else if (contentBinding) {
      own.push(contentBinding)
    }

    this.formTarget = outerTarget

    if (selected) {
      const value = selected

      own.push(variable => b.add(`KayEffect(() => KayProperty(${variable(node)}, "value", (`).addSource(value).add(')));'))
    }

    bindings.push(...own)

    return `${html}</${name}>`
  }

  // Emits what a binding builds with the form it sits in, which was left by the time bindings are written.
  private inForm(target: Span | undefined, emit: () => void): void {
    const outer = this.formTarget

    this.formTarget = target
    emit()
    this.formTarget = outer
  }

  // A handler, a ref, a binding or a transition: what only the browser attaches.
  private behaviour(element: ElementNode, attribute: Attribute, name: string, node: TemplateNode): Binding | undefined {
    const { b } = this

    if (name === 'transition' || name.startsWith(TRANSITION_PART)) {
      const part = name === 'transition' ? 'name' : name.slice(TRANSITION_PART.length)

      return (variable) => {
        b.add(`KayTransition(${variable(node)}, ${JSON.stringify(part)}, `)

        if (attribute.kind === 'expression')
          b.add('(').addSource(attribute.expression).add(')')
        else
          b.add(JSON.stringify(attribute.kind === 'static' ? decodeEntities(attribute.text) : ''))

        b.add(');')
      }
    }

    if (attribute.kind !== 'expression')
      return undefined

    const expression = attribute.expression

    if (name === 'ref')
      return variable => b.add(`KayRef(${variable(node)}, (`).addSource(expression).add('));')

    if (name.startsWith('bind:'))
      return variable => this.bind(element, attribute, name.slice(5), variable(node))

    if (!name.startsWith('on') || name.startsWith('on:'))
      return undefined

    // Read at each event rather than once, so a handler a prop, a signal or a loop item holds stays current.
    return (variable) => {
      b.add(`KayListen(${variable(node)}, ${JSON.stringify(name)}, `)

      if (isFunctionExpression(this.source(expression)))
        b.add('(').addSource(expression).add(')')
      else
        b.add('(kayEvent) => (').addSource(expression).add(')?.(kayEvent)')

      b.add(');')
    }
  }

  // `bind:value={name}` reads the signal and writes it back from the matching input event.
  private bind(element: ElementNode, attribute: Extract<Attribute, { kind: 'expression' }>, property: string, variable: string): void {
    const { b } = this
    const inputType = this.staticAttribute(element, 'type') ?? 'text'
    const event = property === 'checked' || element.name === 'select' ? 'onChange' : 'onInput'
    const read = property === 'checked' ? 'checked' : NUMERIC_INPUTS.has(inputType) ? 'valueAsNumber' : 'value'

    b.add(`KayEffect(() => KayProperty(${variable}, ${JSON.stringify(property)}, (`).addSource(attribute.expression).add(')())); ')
    b.add(`KayListen(${variable}, ${JSON.stringify(event)}, (kayEvent) => `)

    // An emptied number input has no number: the signal keeps its last one rather than take a NaN.
    if (read === 'valueAsNumber')
      b.add('{ const kayValue = kayEvent.currentTarget.valueAsNumber; if (!Number.isNaN(kayValue)) (').addSource(attribute.expression).add(').set(kayValue) });')
    else
      b.add('(').addSource(attribute.expression).add(`).set(kayEvent.currentTarget.${read}));`)
  }

  private spreadBinding(element: ElementNode, variable: string, content: boolean): void {
    const { b } = this

    b.add(`KaySpread(${variable}, () => [`)
    this.sources(element, false)

    if (actionOf(element, this.src)) {
      const defaults = [['method', 'post'], ['enctype', 'multipart/form-data']].filter(([name]) => !this.named(element, name!))

      if (defaults.length > 0)
        b.add(`, { ${defaults.map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`).join(', ')} }`)
    }

    b.add(`]${content ? ', true' : ''});`)
  }

  private component(element: ElementNode): void {
    const { b } = this
    const dynamic = b.isDynamicTag(element.tag)

    b.add(dynamic ? 'KayDynamic(' : 'KayComponent(').addSource(element.tag).add(', ')

    const spreads = element.attributes.some(attribute => attribute.kind === 'spread')

    if (spreads)
      b.add('KayMerge(')

    const props = this.sources(element, true, true)

    for (const slot of element.children.filter((child): child is SlotNode => child.kind === 'slot')) {
      props.separate()

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
      props.separate()
      b.add('get children() { return ')
      this.childrenValue(children)
      b.add(' }')
    }

    props.close()

    if (spreads)
      b.add(')')

    b.add(')')
  }

  // The attributes as props objects, spreads between them in the order written; a component reads each expression through a getter, so it stays live.
  private sources(element: ElementNode, getters: boolean, keepOpen = false): { separate: () => void, close: () => void } {
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

    const entry = (name: string, value: () => void, live: boolean) => {
      separate()

      if (getters && live) {
        b.add(`get ${JSON.stringify(name)}() { return `)
        value()
        b.add(' }')
      }
      else {
        b.add(`${JSON.stringify(name)}: `)
        value()
      }
    }

    if (element.id)
      entry('id', () => b.add(JSON.stringify(this.source(element.id!))), false)

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread') {
        closeObject()
        b.add(objects++ > 0 ? ', (' : '(').addSource(attribute.expression).add(')')

        continue
      }

      if (mergedClass && attribute === classAttribute)
        continue

      const name = this.source(attribute.name)

      if (attribute.kind === 'boolean')
        entry(name, () => b.add('true'), false)
      else if (attribute.kind === 'static')
        entry(name, () => b.add(JSON.stringify(decodeEntities(attribute.text))), false)
      else if (!element.component && attribute === actionOf(element, this.src))
        entry(name, () => b.add('KayFormAction((').addSource(attribute.expression).add('))'), true)
      else if (!element.component && name.startsWith('on') && !isFunctionExpression(this.source(attribute.expression)))
        entry(name, () => b.add('(kayEvent) => (').addSource(attribute.expression).add(')?.(kayEvent)'), false)
      else
        entry(name, () => b.add('(').addSource(attribute.expression).add(')'), true)
    }

    if (mergedClass)
      entry('class', () => this.mergedClass(element, classAttribute, spreads), true)

    if (!keepOpen)
      close()

    return { separate, close }
  }

  // `class` as written: the shorthand alone or merged with a static attribute is a string; with an expression or spreads, an array of every source, which a component gets merged into one string, as its `class?: string` prop takes it.
  private mergedClass(element: ElementNode, classAttribute: NamedAttribute | undefined, spreads: boolean): void {
    const { b } = this
    const shorthand = element.classes.length > 0 ? this.shorthand(element) : undefined

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

    b.add(element.component ? `${domAlias('componentClass')}([` : '[')
    for (const [index, item] of items.entries()) {
      if (index > 0)
        b.add(', ')

      item()
    }
    b.add(element.component ? '])' : ']')
  }

  // What a component receives as `children` or a slot: a lone line of text as its string or values, as JSX passes it, anything else as a block.
  private childrenValue(nodes: Node[]): void {
    const { b } = this
    const lone = nodes.length === 1 && nodes[0]!.kind === 'text' ? nodes[0] : undefined

    if (!lone || lone.parts.some(part => part.kind === 'element')) {
      this.block(nodes)

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

  // The `sizes` of an `img` whose `src` goes through `KayImage`, which caps it for dense screens, so the loop leaves it out.
  private imageSizes(element: ElementNode): NamedAttribute | undefined {
    if (element.name !== 'img' || this.named(element, 'srcset') || !element.attributes.some(attribute => attribute.kind === 'expression' && this.source(attribute.name) === 'src'))
      return undefined

    return element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && attribute.kind !== 'boolean' && this.source(attribute.name) === 'sizes')
  }

  private sizesArgument(sizes: NamedAttribute | undefined): void {
    if (sizes?.kind === 'static')
      this.b.add(`, ${JSON.stringify(decodeEntities(sizes.text))}`)
    else if (sizes?.kind === 'expression')
      this.b.add(', (').addSource(sizes.expression).add(')')
  }

  private named(element: ElementNode, name: string): boolean {
    return element.attributes.some(attribute => attribute.kind !== 'spread' && this.source(attribute.name) === name)
  }

  private staticAttribute(element: ElementNode, name: string): string | undefined {
    for (const attribute of element.attributes) {
      if (attribute.kind === 'static' && this.source(attribute.name) === name)
        return attribute.text
    }

    return undefined
  }

  private source(span: Span): string {
    return this.src.slice(span.start, span.end)
  }
}
