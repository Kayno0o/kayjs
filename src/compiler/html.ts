import type { Attribute, AwaitNode, ElementNode, ErrorMessages, ForNode, IfNode, NamedAttribute, Node, SlotNode, Span, TextNode, TryNode } from './ast'
import type { DynamicItem } from './items'
import type { CodeBuilder } from './mapping'
import { actionOf, errorKey, formFieldOf } from './ast'
import { decodeEntities } from './expression'
import { childItems, soleDynamic } from './items'

// The `kay/html` helpers static server output calls, each imported under a `Kay` name.
const HTML_HELPERS = ['attempt', 'attribute', 'child', 'className', 'component', 'componentClass', 'currentPage', 'dynamic', 'element', 'head', 'imageAttributes', 'loop', 'merge', 'omit', 'raw', 'refillOptions', 'selectOptions', 'show', 'style']

export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'menuitem', 'meta', 'param', 'source', 'track', 'wbr'])
export const RAW_ELEMENTS = new Set(['script', 'style'])
// Properties that set an element's content rather than an attribute.
export const CONTENT_PROPERTIES = new Set(['innerHTML', 'textContent', 'innerText', 'children'])
// Handlers, refs, bindings and transitions, which only an island attaches; `open` is the one attribute starting with `on` that is none.
export const BEHAVIOUR = /^(?:on(?!en$)|ref$|bind:|transition(?::|$))/
const LESS_THAN = /</g
const STATIC_ATTRIBUTE = /["<]|&(?!(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);)/gi
const ATTRIBUTE_ENTITY: Record<string, string> = { '"': '&quot;', '<': '&lt;', '&': '&amp;' }

export function htmlHelperImport(): string {
  return `import { ${HTML_HELPERS.map(helper => `${helper} as ${htmlAlias(helper)}`).join(', ')} } from 'kay/html'\n`
}

function htmlAlias(helper: string): string {
  return `Kay${helper[0]!.toUpperCase()}${helper.slice(1)}`
}

// Around a dynamic part of an island's markup, so the browser finds where it starts and ends.
export const START_MARKER = '<!--[-->'
export const END_MARKER = '<!--]-->'

export interface HtmlOptions {
  // An island or a twin: dynamic parts carry markers for hydration.
  hydratable?: boolean
  // Loop rows read their item, and a keyed row its index, through functions, as the island build of the same template does.
  accessorLoops?: boolean
  // What a refused form's fields are described by.
  errors?: ErrorMessages
}

// Static text written as markup: `& b` and `&amp;` both stay as written, the way JSX text reaches the server markup.
export function escapeText(text: string): string {
  return text.replace(LESS_THAN, '&lt;')
}

// A quoted attribute as JSX reads it, an entity standing for its character, then escaped for markup.
export function escapeStaticAttribute(text: string): string {
  return text.replace(STATIC_ATTRIBUTE, char => ATTRIBUTE_ENTITY[char] ?? '&amp;')
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
  // The action the form being emitted posts to, whose refused post its fields show again.
  private formTarget: Span | undefined

  constructor(private readonly b: CodeBuilder, private readonly src: string, private readonly options: HtmlOptions = {}) {}

  // The nodes' markup as one string expression; an element's content lets a lone dynamic part go without markers.
  markup(nodes: Node[], inElement = false): void {
    const markup = new Markup(this.b)

    this.b.add('(')
    this.children(nodes, markup, false, inElement)
    markup.end()
    this.b.add(')')
  }

  // A rendered value, which a component returns and a prop carries.
  value(nodes: Node[]): void {
    this.b.add('({ t: ')
    this.markup(nodes)
    this.b.add(' })')
  }

  private children(nodes: Node[], markup: Markup, raw: boolean, inElement: boolean): void {
    const items = childItems(nodes)
    const markers = this.options.hydratable === true && !(inElement && soleDynamic(items))

    for (const item of items) {
      if (item.kind === 'text') {
        markup.text(raw ? item.text : escapeText(item.text))
      }
      else if (item.kind === 'element') {
        this.element(item.node, markup)
      }
      else {
        if (markers)
          markup.text(START_MARKER)

        markup.dynamic(() => this.dynamic(item, raw))

        if (markers)
          markup.text(END_MARKER)
      }
    }
  }

  private dynamic(item: DynamicItem, raw: boolean): void {
    const { b } = this

    switch (item.kind) {
      case 'expression':
        b.add(`${htmlAlias(raw ? 'raw' : 'child')}((`).addSource(item.node.expression).add('))')

        break
      case 'component':
        b.wrap(item.node, () => this.component(item.node))

        break
      case 'slot':
        b.wrap(item.node, () => b.add(`${htmlAlias('child')}(__props.children)`))

        break
      case 'if':
        b.wrap(item.node, () => this.if(item.node, 0))

        break
      case 'for':
        this.for(item.node)

        break
      case 'await':
        this.await(item.node)

        break
      case 'try':
        this.try(item.node)

        break
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
      else if (this.options.accessorLoops) {
        b.add(', undefined')
      }

      if (this.options.accessorLoops)
        b.add(node.index !== undefined && node.key !== undefined && this.source(node.key).trim() === this.source(node.index) ? ', "positional"' : ', "keyed"')

      b.add(')')
    })
  }

  private try(node: TryNode): void {
    const { b } = this

    b.wrap(node, () => {
      b.add(`${htmlAlias('attempt')}(() => `)
      this.markup(node.children)

      const branch = node.rejected

      if (branch) {
        b.wrap(branch, () => {
          b.add(', (')

          if (branch.alias)
            b.addSource(branch.alias)

          b.add(') => ')
          this.markup(branch.children)
        })
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
    // What writes the content or the selected value: a bound one reads its signal.
    let content: (() => void) | undefined
    let staticContent: string | undefined
    let rawContent = false
    let selected: (() => void) | undefined
    const read = (expression: Span, call: boolean) => () => void b.add('(').addSource(expression).add(call ? ')()' : ')')
    const target = this.formTarget
    const field = target && formFieldOf(element, this.src)
    // The attribute a refused post's value goes back in, and what the template gives it otherwise.
    const filled = field?.fill === 'value' || field?.fill === 'checked' ? field.fill : undefined
    let ownFill: (() => void) | undefined
    let checkboxValue: (() => void) | undefined
    const imageSizes = this.imageSizes(element)

    const errorId = this.options.errors?.ids.get(element)

    markup.text(`<${name}`)

    if (element.id)
      markup.text(` id="${escapeStaticAttribute(this.source(element.id))}"`)
    else if (errorId)
      markup.text(` id="${escapeStaticAttribute(errorId)}"`)

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
      if (attribute.kind === 'spread' || (element.classes.length > 0 && attribute === classAttribute) || attribute === imageSizes)
        continue

      const attributeName = this.source(attribute.name)

      // A bound value renders as the property it binds, read off its signal.
      if (attributeName.startsWith('bind:') && attribute.kind === 'expression') {
        const property = attributeName.slice(5)
        const value = read(attribute.expression, true)

        if (name === 'textarea' && property === 'value') {
          content = value

          continue
        }

        if (name === 'select' && property === 'value')
          selected = value

        markup.dynamic(() => {
          b.add(`${htmlAlias('attribute')}(${JSON.stringify(property)}, `)
          value()
          b.add(')')
        })

        continue
      }

      if (BEHAVIOUR.test(attributeName))
        continue

      if (attributeName === filled) {
        ownFill = attribute.kind === 'expression' ? read(attribute.expression, false) : () => void b.add(attribute.kind === 'boolean' ? 'true' : JSON.stringify(decodeEntities(attribute.text)))

        continue
      }

      if (filled === 'checked' && attributeName === 'value')
        checkboxValue = attribute.kind === 'expression' ? read(attribute.expression, false) : () => void b.add(attribute.kind === 'boolean' ? '""' : JSON.stringify(decodeEntities(attribute.text)))

      if (attribute.kind === 'boolean') {
        markup.text(` ${attributeName}`)

        continue
      }

      if (attribute.kind === 'static') {
        if (field?.fill === 'content' && attributeName === 'value') {
          content = () => void b.add(JSON.stringify(decodeEntities(attribute.text)))

          continue
        }

        if (attributeName === 'innerHTML') {
          staticContent = attribute.text

          continue
        }

        if (CONTENT_PROPERTIES.has(attributeName) || (name === 'textarea' && attributeName === 'value')) {
          staticContent = escapeText(decodeEntities(attribute.text))

          continue
        }

        markup.text(attribute.text === '' ? ` ${attributeName}` : ` ${attributeName}="${escapeStaticAttribute(decodeEntities(attribute.text))}"`)

        continue
      }

      const expression = attribute.expression

      if (CONTENT_PROPERTIES.has(attributeName) || (name === 'textarea' && (attributeName === 'value' || attributeName === 'defaultValue'))) {
        content = read(expression, false)
        rawContent = attributeName === 'innerHTML' || RAW_ELEMENTS.has(name)

        continue
      }

      if (name === 'select' && attributeName === 'value')
        selected = read(expression, false)

      if (attributeName === 'class' || attributeName === 'style') {
        markup.text(` ${attributeName}="`)
        markup.dynamic(() => b.add(`${htmlAlias(attributeName === 'class' ? 'className' : 'style')}((`).addSource(expression).add('))'))
        markup.text('"')

        continue
      }

      // An imported image loads the size it shows at, unless the template writes its own `srcset`.
      if (name === 'img' && attributeName === 'src' && !this.named(element, 'srcset')) {
        const sized = this.named(element, 'width') || this.named(element, 'height')

        markup.dynamic(() => {
          b.add(`${htmlAlias('imageAttributes')}((`).addSource(expression).add(`), ${sized}`)
          this.sizesArgument(imageSizes)
          b.add(')')
        })

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

    this.currentLink(element, markup)

    if (field && target) {
      const fieldArguments = () => void b.add('((').addSource(target).add(`), ${JSON.stringify(field.name)}`)

      if (filled) {
        markup.dynamic(() => {
          b.add(`${htmlAlias('attribute')}(${JSON.stringify(filled)}, ${filled === 'value' ? 'KayFormValue' : 'KayFormChecked'}`)
          fieldArguments()

          // A radio button with no `value` posts `on`, as a checkbox does, but only the ticked one of its group.
          if (filled === 'checked') {
            b.add(', ')
            checkboxValue ? checkboxValue() : b.add(this.isRadio(element) ? '"on"' : 'undefined')
          }

          b.add(')')

          if (ownFill) {
            b.add(' ?? ')
            ownFill()
          }

          b.add(')')
        })
      }

      if (field.invalid) {
        markup.dynamic(() => {
          b.add(`${htmlAlias('attribute')}("aria-invalid", KayFormInvalid`)
          fieldArguments()
          b.add('))')
        })

        const described = this.describedBy(element, target, field.name)

        if (described) {
          markup.dynamic(() => {
            b.add(`${htmlAlias('attribute')}("aria-describedby", KayFormInvalid`)
            fieldArguments()
            b.add(`) && ${JSON.stringify(described)})`)
          })
        }
      }

      if (field.fill === 'content') {
        const own = content

        content = () => {
          b.add('KayFormValue')
          fieldArguments()
          b.add(') ?? ')
          own ? own() : b.add('undefined')
        }
      }
    }

    const action = actionOf(element, this.src)

    if (action) {
      if (!this.named(element, 'method'))
        markup.text(' method="post"')

      // Multipart whatever the schema, so file inputs post too; Elysia parses either encoding alike.
      if (!this.named(element, 'enctype'))
        markup.text(' enctype="multipart/form-data"')

      const described = this.describedBy(element, action.expression, '')

      if (described)
        markup.dynamic(() => b.add(`${htmlAlias('attribute')}("aria-describedby", KayFormInvalid((`).addSource(action.expression).add(`), "") && ${JSON.stringify(described)})`))
    }

    markup.text('>')

    if (VOID_ELEMENTS.has(name))
      return

    const outerTarget = this.formTarget

    this.formTarget = actionOf(element, this.src)?.expression ?? outerTarget
    this.honeypot(element, () => markup.dynamic(() => this.honeypotField(element)))

    if (children.length > 0 && field?.fill === 'selected' && target) {
      const own = selected

      markup.dynamic(() => {
        b.add(`${htmlAlias('refillOptions')}(KayFormValue((`).addSource(target).add(`), ${JSON.stringify(field.name)}), `)
        this.markup(children, true)

        if (own) {
          b.add(', () => ')
          own()
        }

        b.add(')')
      })
    }
    else if (children.length > 0 && field?.fill === 'content' && target) {
      markup.dynamic(() => {
        b.add('((value) => value === undefined ? ')
        this.markup(children, true)
        b.add(` : ${htmlAlias('child')}(value))(KayFormValue((`).addSource(target).add(`), ${JSON.stringify(field.name)}))`)
      })
    }
    else if (children.length > 0 && selected) {
      markup.dynamic(() => {
        b.add(`${htmlAlias('selectOptions')}(`)
        selected()
        b.add(', ')
        this.markup(children, true)
        b.add(')')
      })
    }
    else if (children.length > 0) {
      this.children(children, markup, RAW_ELEMENTS.has(name), true)
    }
    else if (staticContent !== undefined) {
      markup.text(staticContent)
    }
    else if (content) {
      markup.dynamic(() => {
        b.add(`${htmlAlias(rawContent ? 'raw' : 'child')}(`)
        content()
        b.add(')')
      })
    }

    this.formTarget = outerTarget
    markup.text(`</${name}>`)
  }

  // A link to the page being rendered says so, unless it says itself; an island's links are left to it, its markup claimed as the server wrote it.
  private currentLink(element: ElementNode, markup: Markup): void {
    if (element.name !== 'a' || this.options.hydratable || this.named(element, 'aria-current'))
      return

    const href = element.attributes.find(attribute => attribute.kind !== 'spread' && this.source(attribute.name) === 'href')

    if (href?.kind === 'static' && decodeEntities(href.text).startsWith('/'))
      markup.dynamic(() => this.b.add(`${htmlAlias('currentPage')}(${JSON.stringify(decodeEntities(href.text))})`))
    else if (href?.kind === 'expression')
      markup.dynamic(() => this.b.add(`${htmlAlias('currentPage')}((`).addSource(href.expression).add('))'))
  }

  // A form posting to an action renders the action's honeypot field first; an island leaves it to the template, its markup claimed node by node as it hydrates.
  private honeypot(element: ElementNode, emit: () => void): void {
    if (actionOf(element, this.src) && !this.options.hydratable)
      emit()
  }

  private honeypotField(element: ElementNode): void {
    this.b.add('KayFormHoneypot((').addSource(actionOf(element, this.src)!.expression).add('))')
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
      const outerTarget = this.formTarget

      this.formTarget = actionOf(element, this.src)?.expression ?? outerTarget
      b.add(', () => ')
      this.honeypot(element, () => {
        this.honeypotField(element)
        b.add(' + ')
      })
      this.markup(children, true)
      this.formTarget = outerTarget
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
      b.add(`${htmlAlias('component')}(`).addSource(element.tag).add(', ')

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

  // `class` as written: the shorthand alone or merged with a static attribute is a string; with an expression or spreads, an array of every source, which a component gets merged into one string, as its `class?: string` prop takes it.
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

    b.add(element.component ? `${htmlAlias('componentClass')}([` : '[')
    for (const [index, item] of items.entries()) {
      if (index > 0)
        b.add(', ')

      item()
    }
    b.add(element.component ? '])' : ']')
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

  private isRadio(element: ElementNode): boolean {
    return element.attributes.some(attribute => attribute.kind === 'static' && this.source(attribute.name) === 'type' && attribute.text.toLowerCase() === 'radio')
  }

  // The `sizes` of an `img` whose `src` goes through `imageAttributes`, which caps it for dense screens, so the loop leaves it out.
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

  // The element showing the error a refused post got for the field, `''` for the form's own message, unless the template describes it itself.
  private describedBy(element: ElementNode, action: Span, field: string): string | undefined {
    return this.named(element, 'aria-describedby') ? undefined : this.options.errors?.describing.get(errorKey(this.source(action), field))
  }

  private source(span: Span): string {
    return this.src.slice(span.start, span.end)
  }
}
