import type { Attribute, ElementNode, ErrorMessages, FormField, NamedAttribute, Node, SlotNode, SnippetNode, Span, TemplateFacts, TextNode } from './ast'
import type { CodeBuilder } from './mapping'
import { PART_END, PART_START } from '../runtime/markers'
import { URL_ATTRIBUTES } from '../runtime/url-attributes'
import { actionOf, describedByOf, FIELD_ATTRIBUTE, FIELD_ELEMENTS, formFieldOf, partAttribute, partsOf, sectionOf } from './ast'
import { decodeEntities, isFunctionAt } from './expression'
import { PROPS } from './names'

export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'menuitem', 'meta', 'param', 'source', 'track', 'wbr'])
export const RAW_ELEMENTS = new Set(['script', 'style'])
// Properties that set an element's content rather than an attribute.
export const CONTENT_PROPERTIES = new Set(['innerHTML', 'textContent', 'innerText', 'children'])
// Handlers, refs, bindings and transitions, which only an island attaches.
export const BEHAVIOUR = /^(?:on|ref$|bind:|transition(?::|$))/
const LESS_THAN = /</g
const STATIC_ATTRIBUTE = /["<]|&(?!(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);)/gi
const ATTRIBUTE_ENTITY: Record<string, string> = { '"': '&quot;', '<': '&lt;', '&': '&amp;' }
// The attributes naming URLs of the site, which a path from its root in goes under its base.
const BASED = new Set([...URL_ATTRIBUTES, 'srcset'])
// The attribute of an `img` that leaves out the color it shows until it loads.
const NO_PLACEHOLDER = 'no-placeholder'
// A `srcset` URL from the root, `/a.png 2x` after the start or a comma.
const SRCSET_ROOT_PATH = /(?:^|,)\s*\/(?!\/)/

// Around a dynamic part of an island's markup, so the browser finds where it starts and ends.
export const START_MARKER = `<!--${PART_START}-->`
export const END_MARKER = `<!--${PART_END}-->`

// A path from the site's root, `/about`, rather than `//cdn.example/a.js` on another host.
export function fromRoot(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//')
}

// The name a runtime helper is imported under.
export function helperName(helper: string): string {
  return `Kay${helper[0]!.toUpperCase()}${helper.slice(1)}`
}

// Static text written as markup: `& b` and `&amp;` both stay as written, the way JSX text reaches the server markup.
export function escapeText(text: string): string {
  return text.replace(LESS_THAN, '&lt;')
}

const NUMERIC_INPUTS = new Set(['number', 'range'])

// What a `bind:` reads from the input on its event: a checkbox's `checked`, a number or range input's number, else its text.
export function bindRead(property: string, inputType: string): 'checked' | 'valueAsNumber' | 'value' {
  if (property === 'checked')
    return 'checked'

  return NUMERIC_INPUTS.has(inputType) ? 'valueAsNumber' : 'value'
}

// The body of a `bind:` event handler, `(kayEvent) => ` before it: it writes what the input holds back to the signal, which the caller closes.
export function addBindWrite(b: CodeBuilder, expression: Span, read: string): void {
  // An emptied number input has no number: the signal keeps its last one rather than take a NaN, or an undefined its type does not allow.
  if (read === 'valueAsNumber')
    b.add('{ const kayValue = kayEvent.currentTarget.valueAsNumber; if (!Number.isNaN(kayValue)) (').addSource(expression).add(').set(kayValue) }')
  else
    b.add('(').addSource(expression).add(`).set(kayEvent.currentTarget.${read})`)
}

// A quoted attribute as JSX reads it, an entity standing for its character, then escaped for markup.
export function escapeStaticAttribute(text: string): string {
  return text.replace(STATIC_ATTRIBUTE, char => ATTRIBUTE_ENTITY[char] ?? '&amp;')
}

// What follows `KayFormInvalid(...` for a refused field or form: the value naming its error after the template's own, else the template's own or none.
export function describedValue(described: { id: string, own?: string }): string {
  return `) ? ${JSON.stringify(described.own === undefined ? described.id : `${described.own} ${described.id}`)} : ${described.own === undefined ? 'undefined' : JSON.stringify(described.own)}`
}

// An attribute of an element without spreads, as both templates read it; a static text is decoded.
export type PlannedAttribute
  = | { kind: 'boolean', name: string }
    | { kind: 'text', name: string, text: string, bare: boolean }
  // A static path from the site's root, which goes under its base and, for a link, to the page's locale's copy.
    | { kind: 'rooted', name: string, text: string }
    | { kind: 'class' | 'style', name: string, expression: Span }
  // An `img` source, which loads the size the image shows at.
    | { kind: 'image', expression: Span, sized: boolean, placeholder: boolean }
  // A `select`'s value, which picks its option.
    | { kind: 'selected', expression: Span }
    | { kind: 'bind', name: string, property: string, expression: Span }
    | { kind: 'behaviour', name: string, attribute: Attribute }
    | { kind: 'value', name: string, expression: Span, action: boolean }

// What an element without spreads renders, decided once for the server's markup and the browser's template.
export interface ElementPlan {
  id: string | undefined
  // The class shorthand, merged with a static `class`, or beside an expression one.
  classes: { text: string, expression?: Span | undefined, parts?: string[] } | undefined
  attributes: PlannedAttribute[]
  // The `sizes` an image source caps, left out of the attributes.
  sizes: NamedAttribute | undefined
  // Markup written as the content; a textarea's static `value` is also kept as its text.
  staticContent: string | undefined
  valueText: string | undefined
  // An expression setting the content, read off its signal when `bound`.
  content: { expression: Span, property: string, raw: boolean, bound: boolean } | undefined
  selected: { expression: Span, bound: boolean } | undefined
  action: { expression: Span, method: boolean, enctype: boolean } | undefined
  // The action of the form the element sits in, and the field it is of that form.
  target: Span | undefined
  field: FormField | undefined
  // The `aria-describedby` a refused field or form takes.
  described: { id: string, own?: string } | undefined
}

// What the server and browser templates write alike: an element's attributes as props objects and a component's props.
export abstract class TemplateWriter {
  constructor(protected readonly b: CodeBuilder, protected readonly src: string, protected readonly facts: TemplateFacts) {}

  // Whether a component's slots and children are handed over as a function building them: in the browser, so a slot read in an attribute, a test or a ternary builds nothing and claims no server markup while an island hydrates.
  // The server hands over the markup itself, which an island reads its static slots off, and so draws a slot's ids once per read where the browser draws them once per insert; the browser sets the ids it binds, so they agree.
  protected readonly lazySlots: boolean = false

  // Children rendered as the template renders them: markup on the server, a block in the browser.
  protected abstract rendered(nodes: Node[]): void

  // An attribute the props leave out.
  protected abstract skips(element: ElementNode, name: string): boolean

  protected plan(element: ElementNode, errors: ErrorMessages | undefined): ElementPlan {
    const name = element.name
    const target = this.facts.forms.get(element)
    const classAttribute = this.classAttribute(element)
    const sizes = this.imageSizes(element)
    const field = target && formFieldOf(element, this.src)
    const action = actionOf(element, this.src)
    const fieldDescribed = target && field?.invalid ? describedByOf(element, this.src, errors, target, field.name) : undefined
    const described = field ? fieldDescribed : action && describedByOf(element, this.src, errors, action.expression, '')
    const plan: ElementPlan = {
      id: element.id ? this.source(element.id) : errors?.ids.get(element),
      classes: undefined,
      attributes: [],
      sizes,
      staticContent: undefined,
      valueText: undefined,
      content: undefined,
      selected: undefined,
      action: action && { expression: action.expression, method: !this.named(element, 'method'), enctype: !this.named(element, 'enctype') },
      target,
      field,
      described,
    }

    const parts = partsOf(element, this.src, this.facts.parts)
    const partAttr = partAttribute(element, this.src)

    if (parts.length > 0)
      plan.classes = { text: this.staticClass(element, classAttribute?.kind === 'expression' ? undefined : classAttribute).trim(), expression: classAttribute?.kind === 'expression' ? classAttribute.expression : undefined, parts }
    else if (element.classes.length > 0)
      plan.classes = classAttribute?.kind === 'expression' ? { text: this.shorthand(element), expression: classAttribute.expression } : { text: this.staticClass(element, classAttribute) }

    const section = name === 'a' ? sectionOf(element, this.src) : undefined

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread' || (plan.classes && attribute === classAttribute) || attribute === sizes)
        continue

      const attributeName = this.source(attribute.name)

      if (attribute === partAttr) {
        plan.attributes.push({ kind: 'text', name: 'data-part', text: decodeEntities(attribute.text), bare: false })

        continue
      }

      // Read below with the image's source, and never written.
      if (name === 'img' && attributeName === NO_PLACEHOLDER)
        continue

      // Read by `currentLink` on the server, and never written, a repeat of it included.
      if (section !== undefined && attributeName === 'section' && (attribute.kind === 'boolean' || attribute.kind === 'expression'))
        continue

      if (attributeName.startsWith('bind:') && attribute.kind === 'expression') {
        const property = attributeName.slice(5)

        if (name === 'textarea' && property === 'value')
          plan.content = { expression: attribute.expression, property, raw: false, bound: true }
        else if (name === 'select' && property === 'value')
          plan.selected = { expression: attribute.expression, bound: true }

        plan.attributes.push({ kind: 'bind', name: attributeName, property, expression: attribute.expression })
      }
      else if (BEHAVIOUR.test(attributeName)) {
        plan.attributes.push({ kind: 'behaviour', name: attributeName, attribute })
      }
      else if (described?.own !== undefined && attributeName === 'aria-describedby') {
        continue
      }
      else if (attribute.kind === 'boolean') {
        plan.attributes.push({ kind: 'boolean', name: attributeName })
      }
      else if (attribute.kind === 'static') {
        const text = decodeEntities(attribute.text)

        if (attributeName === FIELD_ATTRIBUTE && FIELD_ELEMENTS.has(name)) {
          plan.attributes.push({ kind: 'text', name: 'name', text, bare: false })
        }
        else if (attributeName === 'innerHTML') {
          plan.staticContent = attribute.text
        }
        else if (CONTENT_PROPERTIES.has(attributeName) || (name === 'textarea' && attributeName === 'value')) {
          plan.staticContent = escapeText(text)
          plan.valueText = attributeName === 'value' ? text : undefined
        }
        else if (BASED.has(attributeName) && (attributeName === 'srcset' ? SRCSET_ROOT_PATH.test(text) : fromRoot(text))) {
          plan.attributes.push({ kind: 'rooted', name: attributeName, text })
        }
        else {
          plan.attributes.push({ kind: 'text', name: attributeName, text, bare: attribute.text === '' })
        }
      }
      else if (CONTENT_PROPERTIES.has(attributeName) || (name === 'textarea' && (attributeName === 'value' || attributeName === 'defaultValue'))) {
        plan.content = { expression: attribute.expression, property: attributeName === 'defaultValue' ? 'value' : attributeName, raw: attributeName === 'innerHTML' || RAW_ELEMENTS.has(name), bound: false }
      }
      else if (name === 'select' && attributeName === 'value') {
        plan.selected = { expression: attribute.expression, bound: false }
        plan.attributes.push({ kind: 'selected', expression: attribute.expression })
      }
      else if (attributeName === 'class' || attributeName === 'style') {
        plan.attributes.push({ kind: attributeName, name: attributeName, expression: attribute.expression })
      }
      // An imported image loads the size it shows at, unless the template writes its own `srcset`.
      else if (name === 'img' && attributeName === 'src' && !this.named(element, 'srcset')) {
        plan.attributes.push({ kind: 'image', expression: attribute.expression, sized: this.named(element, 'width') || this.named(element, 'height'), placeholder: !this.named(element, 'style') && !this.named(element, NO_PLACEHOLDER) })
      }
      else {
        plan.attributes.push({ kind: 'value', name: attributeName, expression: attribute.expression, action: attribute === action })
      }
    }

    for (const [attributeName, text] of this.imageDefaults(element))
      plan.attributes.push({ kind: 'text', name: attributeName, text, bare: false })

    return plan
  }

  // An image loads lazily and decodes off the main thread unless the template says otherwise: a hero above the fold sets `loading="eager"` or `fetchpriority="high"`.
  protected imageDefaults(element: ElementNode): [string, string][] {
    if (element.name !== 'img')
      return []

    const defaults: [string, string][] = []

    if (!this.named(element, 'loading') && !this.named(element, 'fetchpriority'))
      defaults.push(['loading', 'lazy'])

    if (!this.named(element, 'decoding'))
      defaults.push(['decoding', 'async'])

    return defaults
  }

  // The image defaults as a props object leading an element's sources, so a spread carrying its own wins.
  protected leadingImageDefaults(element: ElementNode): void {
    const defaults = this.imageDefaults(element)

    if (defaults.length > 0)
      this.b.add(`{ ${defaults.map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`).join(', ')} }, `)
  }

  // A snippet as a statement declaring a function of its parameters returning what its lines render, as a slot block taking parameters does.
  protected snippetDeclaration(node: SnippetNode): void {
    const { b } = this

    b.wrap(node, () => {
      b.add('const ').addSource(node.name).add(' = (').addSource(node.params).add(') => ')
      this.childrenValue(node.children)
      b.add('; ')
    })
  }

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
        this.childrenValue(slot.children, this.lazySlots)
        b.add(' }')
      }
    }

    const children = element.children.filter(child => child.kind !== 'slot')

    if (children.length > 0) {
      props.separate()
      b.add('get children() { return ')
      this.childrenValue(children, this.lazySlots)
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
    const parts = partsOf(element, this.src, this.facts.parts)
    const partAttr = partAttribute(element, this.src)
    const mergedClass = element.classes.length > 0 || (spreads && classAttribute !== undefined) || parts.length > 0
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

    const namedEntry = (attribute: NamedAttribute, name: string) => {
      if (attribute.kind === 'boolean')
        entry(name, () => b.add('true'), false)
      else if (attribute.kind === 'static')
        entry(name, () => b.add(JSON.stringify(decodeEntities(attribute.text))), false)
      else if (!element.component && attribute === actionOf(element, this.src))
        entry(name, () => b.add('KayFormAction((').addSource(attribute.expression).add('))'), true)
      else if (!element.component && name.startsWith('on') && !isFunctionAt(this.src, attribute.expression, this.facts.functions))
        entry(name, () => b.add('(kayEvent) => (').addSource(attribute.expression).add(')?.(kayEvent)'), false)
      else
        entry(name, () => b.add('(').addSource(attribute.expression).add(')'), true)
    }

    const lastSpread = element.attributes.findLastIndex(attribute => attribute.kind === 'spread')
    const ownStyle = element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && this.source(attribute.name) === 'style')

    if (element.id)
      entry('id', () => b.add(JSON.stringify(this.source(element.id!))), false)

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread') {
        closeObject()
        // On an element, a spread brings attributes only: see `spreadAttributes`.
        b.add(objects++ > 0 ? ', ' : '').add(element.component ? '(' : `${helperName('spreadAttributes')}(`).addSource(attribute.expression).add(')')

        continue
      }

      if (mergedClass && attribute === classAttribute)
        continue

      if (attribute === partAttr) {
        entry('data-part', () => b.add(JSON.stringify(decodeEntities(attribute.text))), false)

        continue
      }

      const name = this.source(attribute.name)

      // Takes the color a spread brings off the image, which the attributes after it cannot unset.
      if (element.name === 'img' && name === NO_PLACEHOLDER) {
        entry('style', () => b.add('undefined'), false)

        continue
      }

      if (this.skips(element, name))
        continue

      namedEntry(attribute, name)
    }

    // A spread after an `img`'s own `style` would replace it with the color `image()` brings, so the `style` is written again after the last one.
    if (element.name === 'img' && ownStyle !== undefined && element.attributes.lastIndexOf(ownStyle) < lastSpread)
      namedEntry(ownStyle, 'style')

    if (mergedClass)
      entry('class', () => this.mergedClass(element, classAttribute, spreads), true)

    if (!keepOpen)
      close()

    return { separate, close }
  }

  // A class list of the static text, the expression and what the component's props hand each part it answers for, later ones overriding earlier.
  protected classList(classes: NonNullable<ElementPlan['classes']>): void {
    const { b } = this

    const { expression } = classes
    const items: (() => void)[] = []

    if (classes.text !== '' || (expression === undefined && classes.parts === undefined))
      items.push(() => b.add(JSON.stringify(classes.text)))

    if (expression !== undefined)
      items.push(() => b.add('(').addSource(expression).add(')'))

    for (const part of classes.parts ?? []) {
      this.recipeItem(items, part)
      items.push(() => b.add(`${helperName('partClass')}(${PROPS}, ${JSON.stringify(part)})`))
    }

    b.add('[')

    for (const [index, item] of items.entries()) {
      if (index > 0)
        b.add(', ')

      item()
    }

    b.add(']')
  }

  // The classes the component's recipe gives a part, after the element's own and before the `class` prop's entry, so the base gives way to a variant and a variant to the caller.
  private recipeItem(items: (() => void)[], part: string): void {
    const { recipe } = this.facts

    if (recipe !== undefined)
      items.push(() => this.b.add(`${recipe}(${PROPS}, ${JSON.stringify(part)})`))
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
    const parts = partsOf(element, this.src, this.facts.parts)

    if (!spreads && classAttribute?.kind !== 'expression' && parts.length === 0) {
      b.add(JSON.stringify(this.staticClass(element, classAttribute)))

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

    for (const part of parts) {
      this.recipeItem(items, part)
      items.push(() => b.add(`${helperName('partClass')}(${PROPS}, ${JSON.stringify(part)})`))
    }

    b.add(element.component ? `${helperName(parts.length > 0 ? 'partsClass' : 'componentClass')}([` : '[')
    for (const [index, item] of items.entries()) {
      if (index > 0)
        b.add(', ')

      item()
    }
    b.add(element.component ? '])' : ']')
  }

  // What a component receives as `children` or a slot: a lone line of text as its string or values, as JSX passes it, anything else rendered.
  // With `lazy`, rendered children are a function building them, which `eachChild` calls where they are put.
  protected childrenValue(nodes: Node[], lazy = false): void {
    const { b } = this
    const lone = nodes.length === 1 && nodes[0]!.kind === 'text' ? nodes[0] : undefined

    if (!lone || lone.parts.some(part => part.kind === 'element')) {
      if (lazy)
        b.add('() => (')

      this.rendered(nodes)

      if (lazy)
        b.add(')')

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

  // The shorthand merged with a static `class` into one string.
  protected staticClass(element: ElementNode, classAttribute: NamedAttribute | undefined): string {
    const shorthand = this.shorthand(element)

    return classAttribute?.kind === 'static' ? `${shorthand} ${decodeEntities(classAttribute.text)}` : shorthand
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
