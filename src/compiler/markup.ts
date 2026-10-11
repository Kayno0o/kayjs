import type { ElementNode, NamedAttribute, Node, SlotNode, Span, TextNode } from './ast'
import type { CodeBuilder } from './mapping'
import { PART_END, PART_START } from '../runtime/markers'
import { actionOf } from './ast'
import { decodeEntities, isFunctionExpression } from './expression'

export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'menuitem', 'meta', 'param', 'source', 'track', 'wbr'])
export const RAW_ELEMENTS = new Set(['script', 'style'])
// Properties that set an element's content rather than an attribute.
export const CONTENT_PROPERTIES = new Set(['innerHTML', 'textContent', 'innerText', 'children'])
// Handlers, refs, bindings and transitions, which only an island attaches.
export const BEHAVIOUR = /^(?:on|ref$|bind:|transition(?::|$))/
const LESS_THAN = /</g
const STATIC_ATTRIBUTE = /["<]|&(?!(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);)/gi
const ATTRIBUTE_ENTITY: Record<string, string> = { '"': '&quot;', '<': '&lt;', '&': '&amp;' }

// Around a dynamic part of an island's markup, so the browser finds where it starts and ends.
export const START_MARKER = `<!--${PART_START}-->`
export const END_MARKER = `<!--${PART_END}-->`

// The name a runtime helper is imported under.
export function helperName(helper: string): string {
  return `Kay${helper[0]!.toUpperCase()}${helper.slice(1)}`
}

// Static text written as markup: `& b` and `&amp;` both stay as written, the way JSX text reaches the server markup.
export function escapeText(text: string): string {
  return text.replace(LESS_THAN, '&lt;')
}

// A quoted attribute as JSX reads it, an entity standing for its character, then escaped for markup.
export function escapeStaticAttribute(text: string): string {
  return text.replace(STATIC_ATTRIBUTE, char => ATTRIBUTE_ENTITY[char] ?? '&amp;')
}

// What follows `KayFormInvalid(...` for a refused field or form: the value naming its error, else the template's own or none.
export function describedValue(described: { refused: string, own?: string }): string {
  return `) ? ${JSON.stringify(described.refused)} : ${described.own === undefined ? 'undefined' : JSON.stringify(described.own)}`
}

// What the server and browser templates write alike: an element's attributes as props objects and a component's props.
export abstract class TemplateWriter {
  constructor(protected readonly b: CodeBuilder, protected readonly src: string) {}

  // Children rendered as the template renders them: markup on the server, a block in the browser.
  protected abstract rendered(nodes: Node[]): void

  // An attribute the props leave out.
  protected abstract skips(element: ElementNode, name: string): boolean

  // A component's props: its attributes, then its slots and children, each read through a getter or a function so it renders where the component puts it.
  protected componentProps(element: ElementNode, getters: boolean): void {
    const { b } = this
    const spreads = element.attributes.some(attribute => attribute.kind === 'spread')

    if (spreads)
      b.add(`${helperName('merge')}(`)

    const props = this.sources(element, getters, true)

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
  }

  // The attributes as props objects, spreads between them in the order written; the class a shorthand, an attribute and the spreads each bring merges last.
  // With `getters`, a component reads each expression through a getter, so it stays live. Returns the last object, still open with `keepOpen`, for a component to add its children and slots to.
  protected sources(element: ElementNode, getters: boolean, keepOpen = false): { separate: () => void, close: () => void } {
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

      if (this.skips(element, name))
        continue

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

  // The `method` and `enctype` a form posting to an action takes unless it sets its own, as one more props object.
  protected formDefaults(element: ElementNode): void {
    if (!actionOf(element, this.src))
      return

    const defaults = [['method', 'post'], ['enctype', 'multipart/form-data']].filter(([name]) => !this.named(element, name!))

    if (defaults.length > 0)
      this.b.add(`, { ${defaults.map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`).join(', ')} }`)
  }

  // `class` as written: the shorthand alone or merged with a static attribute is a string; with an expression or spreads, an array of every source, which a component gets merged into one string, as its `class?: string` prop takes it.
  protected mergedClass(element: ElementNode, classAttribute: NamedAttribute | undefined, spreads: boolean): void {
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

    b.add(element.component ? `${helperName('componentClass')}([` : '[')
    for (const [index, item] of items.entries()) {
      if (index > 0)
        b.add(', ')

      item()
    }
    b.add(element.component ? '])' : ']')
  }

  // What a component receives as `children` or a slot: a lone line of text as its string or values, as JSX passes it, anything else rendered.
  protected childrenValue(nodes: Node[]): void {
    const { b } = this
    const lone = nodes.length === 1 && nodes[0]!.kind === 'text' ? nodes[0] : undefined

    if (!lone || lone.parts.some(part => part.kind === 'element')) {
      this.rendered(nodes)

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

  protected classAttribute(element: ElementNode): NamedAttribute | undefined {
    return element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && this.source(attribute.name) === 'class')
  }

  protected shorthand(element: ElementNode): string {
    return element.classes.map(span => this.source(span)).join(' ')
  }

  // The `sizes` of an `img` whose `src` goes through the image helper, which caps it for dense screens, so the loop leaves it out.
  protected imageSizes(element: ElementNode): NamedAttribute | undefined {
    if (element.name !== 'img' || this.named(element, 'srcset') || !element.attributes.some(attribute => attribute.kind === 'expression' && this.source(attribute.name) === 'src'))
      return undefined

    return element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && attribute.kind !== 'boolean' && this.source(attribute.name) === 'sizes')
  }

  protected sizesArgument(sizes: NamedAttribute | undefined): void {
    if (sizes?.kind === 'static')
      this.b.add(`, ${JSON.stringify(decodeEntities(sizes.text))}`)
    else if (sizes?.kind === 'expression')
      this.b.add(', (').addSource(sizes.expression).add(')')
  }

  protected named(element: ElementNode, name: string): boolean {
    return element.attributes.some(attribute => attribute.kind !== 'spread' && this.source(attribute.name) === name)
  }

  protected source(span: Span): string {
    return this.src.slice(span.start, span.end)
  }
}
