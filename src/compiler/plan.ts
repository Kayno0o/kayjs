import type { Attribute, ElementNode, NamedAttribute, Span } from './ast'
import type { CodeBuilder } from './mapping'
import { actionOf } from './ast'
import { decodeEntities } from './expression'

// Whether a group (the signal of a `bind:group`, a string for radios or an array for checkboxes) holds a value, as the checked state of the box reads it.
export const GROUP_HAS = '((kayGroup: unknown, kayValue: string) => Array.isArray(kayGroup) ? kayGroup.includes(kayValue) : kayGroup === kayValue)'

// The value a box of a `bind:group` stands for: its static `value`, the expression of a bound one, else the `on` a box without one submits.
export function groupValue(element: ElementNode, text: (span: Span) => string): { text: string } | { expression: Span } {
  for (const attribute of element.attributes) {
    if (attribute.kind === 'spread' || text(attribute.name) !== 'value')
      continue

    if (attribute.kind === 'static')
      return { text: decodeEntities(attribute.text) }

    if (attribute.kind === 'boolean')
      return { text: '' }

    if (attribute.kind === 'expression')
      return { expression: attribute.expression }
  }

  return { text: 'on' }
}

// Whether the box of a `bind:group` is checked: its group's signal holds the value the box stands for.
export function addGroupChecked(b: CodeBuilder, group: Span, value: ReturnType<typeof groupValue>): void {
  b.add(`${GROUP_HAS}((`).addSource(group).add(')(), ')

  if ('text' in value)
    b.add(JSON.stringify(value.text))
  else
    b.add('(').addSource(value.expression).add(')')

  b.add(')')
}

// Whether the element writes an attribute of that name; a spread may bring one this cannot see.
export function writesAttribute(element: ElementNode, name: string, src: string): boolean {
  return element.attributes.some(attribute => attribute.kind !== 'spread' && src.slice(attribute.name.start, attribute.name.end) === name)
}

// The classes of the `.class` shorthand, as one `class` value.
export function shorthandClass(element: ElementNode, src: string): string {
  return element.classes.map(span => src.slice(span.start, span.end)).join(' ')
}

// The text of an attribute written as a quoted string.
export function staticAttributeText(element: ElementNode, name: string, src: string): string | undefined {
  for (const attribute of element.attributes) {
    if (attribute.kind === 'static' && src.slice(attribute.name.start, attribute.name.end) === name)
      return attribute.text
  }

  return undefined
}

// The `method` and `enctype` a form posting to an action takes unless it sets its own; multipart whatever the schema, so file inputs post too.
export function formDefaultsOf(element: ElementNode, src: string): { method: boolean, enctype: boolean } | undefined {
  if (!actionOf(element, src))
    return undefined

  return { method: !writesAttribute(element, 'method', src), enctype: !writesAttribute(element, 'enctype', src) }
}

// Handlers, refs, bindings and transitions, which only an island attaches.
export const BEHAVIOUR = /^(?:on|ref$|bind:|transition(?::|$))/
const TRANSITION_PART = 'transition:'

// What an island attaches for a `bind:`, `ref`, `on*` or `transition` attribute, decided once from its name and its value for every target: the server leaves all but a `bind:` to the browser, which turns each into code, and the type check reads the `bind:` and the handler.
export type BindingPlan
  = | { kind: 'bind', name: string, property: string, expression: Span }
    | { kind: 'transition', part: string, attribute: Attribute }
    | { kind: 'ref', expression: Span }
    | { kind: 'handler', name: string, attribute: Extract<Attribute, { kind: 'expression' }> }
  // Written like a binding but attaching nothing: a `ref` or a handler without an expression, an `on:` name.
    | { kind: 'inert' }

// The binding an attribute named `name` is, if it is one.
export function bindingOf(name: string, attribute: Attribute): BindingPlan | undefined {
  if (name.startsWith('bind:') && attribute.kind === 'expression')
    return { kind: 'bind', name, property: name.slice(5), expression: attribute.expression }

  if (!BEHAVIOUR.test(name))
    return undefined

  if (name === 'transition' || name.startsWith(TRANSITION_PART))
    return { kind: 'transition', part: name === 'transition' ? 'name' : name.slice(TRANSITION_PART.length), attribute }

  if (attribute.kind !== 'expression')
    return { kind: 'inert' }

  if (name === 'ref')
    return { kind: 'ref', expression: attribute.expression }

  return name.startsWith('on') && !name.startsWith('on:') ? { kind: 'handler', name, attribute } : { kind: 'inert' }
}

// What a `bind:value` sets on a textarea, whose content it is, or a select, whose option it picks.
export function valueBoundBy(element: string, binding: BindingPlan): { content: { expression: Span, property: string, raw: boolean, bound: boolean } } | { selected: { expression: Span, bound: boolean } } | undefined {
  if (binding.kind !== 'bind' || binding.property !== 'value')
    return undefined

  if (element === 'textarea')
    return { content: { expression: binding.expression, property: binding.property, raw: false, bound: true } }

  return element === 'select' ? { selected: { expression: binding.expression, bound: true } } : undefined
}

// How the shorthand, the `class` attribute and the `class` of each spread of an element merge.
export interface ClassMerge {
  // The first `class` attribute written, and the span of the `.class` shorthand.
  attribute: NamedAttribute | undefined
  shorthand: Span | undefined
  spreads: boolean
  // Whether the shorthand or a `class` beside a spread is written, so the `class` attribute is left to the merge.
  written: boolean
  // Whether the shorthand merges with the `class` attribute where it stands rather than after every spread.
  inline: boolean
  // Whether the merge goes after every attribute and spread, as a spread may bring a `class` of its own.
  last: boolean
}

export function classMergeOf(element: ElementNode, src: string): ClassMerge {
  const attribute = element.attributes.find((candidate): candidate is NamedAttribute => candidate.kind !== 'spread' && src.slice(candidate.name.start, candidate.name.end) === 'class')
  const spreads = element.attributes.some(candidate => candidate.kind === 'spread')
  const shorthand = element.classes.length > 0 ? { start: element.classes[0]!.start, end: element.classes.at(-1)!.end } : undefined

  return { attribute, shorthand, spreads, written: shorthand !== undefined || (spreads && attribute !== undefined), inline: shorthand !== undefined && !spreads, last: spreads && (shorthand !== undefined || attribute !== undefined) }
}

// What an element is for the type check and the markup alike: how its classes merge, the action it posts to, the form it sits in and the URLs it names; a spread leaves these as they are.
export interface ElementShape {
  classMerge: ClassMerge
  action: { expression: Span, method: boolean, enctype: boolean } | undefined
  // The action of the form the element sits in.
  target: Span | undefined
  // What an `a` may do with its `href`, as the server and the browser both write it.
  link: LinkPlan
}

const LINK_ELEMENTS = new Set(['a', 'area'])
// The attribute of an element that names a URL the site's pages may serve, which `kay check` matches against them.
const WRITTEN_URLS = new Map([['img', 'src'], ['link', 'href'], ['form', 'action']])
const WHITESPACE = /\s+/
const NO_ATTRIBUTES: Attribute[] = []

// A feed or a translation, served by what `kay check` does not list as pages, or a form posting to a route that may take its method only.
function servedOtherwise(element: ElementNode, src: string): boolean {
  const value = (name: string) => element.attributes.find(attribute => attribute.kind !== 'spread' && src.slice(attribute.name.start, attribute.name.end) === name)
  const rel = value('rel')
  const method = value('method')

  if (element.name === 'form')
    return method !== undefined && (method.kind !== 'static' || method.text.toLowerCase() !== 'get')

  return element.name === 'link' && rel?.kind === 'static' && rel.text.split(WHITESPACE).includes('alternate')
}

// The attributes of an element that name a URL of the site, which a link must match a page of: an `href` of a link, a written `src`, `href` or `action`.
function checkedUrls(element: ElementNode, src: string): Attribute[] {
  const written = WRITTEN_URLS.get(element.name)

  if (written === undefined && !LINK_ELEMENTS.has(element.name))
    return NO_ATTRIBUTES

  return element.attributes.filter((attribute) => {
    if (attribute.kind === 'spread' || attribute.kind === 'boolean')
      return false

    const name = src.slice(attribute.name.start, attribute.name.end)

    return (LINK_ELEMENTS.has(element.name) && name === 'href') || (attribute.kind === 'static' && written === name && !servedOtherwise(element, src))
  })
}

// Whether an `a` may leave the site (it then opens in a new tab unless it sets its own `target`, and `rel` is kept when written), goes to the page's locale's copy of what it names, or keeps its `href` as written because it carries `hreflang`: `local` and `written` are each other's opposite for an `a`, both false for any other element.
export interface LinkPlan {
  leaving: boolean
  local: boolean
  written: boolean
  rel: boolean
  // The attributes naming a URL of the site, which the type check matches against its pages.
  checked: Attribute[]
}

const NO_LINK: LinkPlan = { leaving: false, local: false, written: false, rel: false, checked: NO_ATTRIBUTES }

// What an element's `href` may do, as the server and the browser both write it.
export function linkOf(element: ElementNode, src: string): LinkPlan {
  const checked = checkedUrls(element, src)

  if (element.name !== 'a')
    return checked === NO_ATTRIBUTES ? NO_LINK : { ...NO_LINK, checked }

  const hreflang = writesAttribute(element, 'hreflang', src)

  return { leaving: !writesAttribute(element, 'target', src), local: !hreflang, written: hreflang, rel: writesAttribute(element, 'rel', src), checked }
}

// The shape of an element sitting in the form that posts to `target`, if any.
export function shapeOf(element: ElementNode, src: string, target: Span | undefined): ElementShape {
  const action = actionOf(element, src)

  return { classMerge: classMergeOf(element, src), action: action && { expression: action.expression, ...formDefaultsOf(element, src)! }, target, link: linkOf(element, src) }
}
