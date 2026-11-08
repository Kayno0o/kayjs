import type { ElementNode, Span } from './ast'
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

// Whether an `a` may leave the site (it then opens in a new tab unless it sets its own `target`, and `rel` is kept when written), goes to the page's locale's copy of what it names, or keeps its `href` as written because it carries `hreflang`: `local` and `written` are each other's opposite for an `a`, both false for any other element.
export interface LinkPlan {
  leaving: boolean
  local: boolean
  written: boolean
  rel: boolean
}

const NO_LINK: LinkPlan = { leaving: false, local: false, written: false, rel: false }

// What an element's `href` may do, as the server and the browser both write it.
export function linkOf(element: ElementNode, src: string): LinkPlan {
  if (element.name !== 'a')
    return NO_LINK

  const hreflang = writesAttribute(element, 'hreflang', src)

  return { leaving: !writesAttribute(element, 'target', src), local: !hreflang, written: hreflang, rel: writesAttribute(element, 'rel', src) }
}
