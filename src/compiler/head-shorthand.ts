import type { ElementNode, NamedAttribute, Span } from './ast'
import type { CodeBuilder } from './mapping'

type Text = (span: Span) => string
type Written = Extract<NamedAttribute, { kind: 'static' | 'expression' }>

// The attributes `head(...)` takes in place of a tag each, as the `seo` of a page's settings and the config do: the tag each makes, and the prop that holds its value.
export const HEAD_SHORTHAND: ReadonlyMap<string, { tag: string, match?: [string, string], prop?: string }> = new Map([
  ['title', { tag: 'title' }],
  ['description', { tag: 'meta', match: ['name', 'description'], prop: 'content' }],
  ['image', { tag: 'meta', match: ['property', 'og:image'], prop: 'content' }],
  ['canonical', { tag: 'link', match: ['rel', 'canonical'], prop: 'href' }],
  ['noindex', { tag: 'meta', match: ['name', 'robots'], prop: 'content' }],
])

// What is wrong with the attributes of a `head` block: anything but those above.
export function shorthandProblems(head: ElementNode | undefined, text: Text): [Span, string][] {
  const message = '`head` takes `title`, `description`, `image`, `canonical` and `noindex` as attributes; any other tag goes in the block'

  const problems = (head?.attributes ?? []).flatMap((attribute): [Span, string][] => {
    const span = attribute.kind === 'spread' ? attribute.expression : attribute.name

    const name = attribute.kind === 'spread' ? '' : text(attribute.name)

    return HEAD_SHORTHAND.has(name) && (attribute.kind !== 'boolean' || name === 'noindex') ? [] : [[span, message]]
  })

  return head !== undefined && (head.classes.length > 0 || head.id) ? [[head, 'A `head` block takes no class or id'], ...problems] : problems
}

// The expressions of the shorthand attributes as statements, which a check reads as the template's own.
export function addShorthandChecks(b: CodeBuilder, head: ElementNode): void {
  for (const attribute of head.attributes) {
    if (attribute.kind === 'expression')
      b.add('void (').addSource(attribute.expression).add(');\n')
  }
}

// Whether `head(...)` gives a `title`, which an island follows.
export function hasShorthandTitle(head: ElementNode | undefined, text: Text): boolean {
  return shorthandOf(head, 'title', text) !== undefined
}

function shorthandOf(head: ElementNode | undefined, name: string, text: Text): Written | undefined {
  return head?.attributes.find((attribute): attribute is Written => (attribute.kind === 'static' || attribute.kind === 'expression') && text(attribute.name) === name)
}

// The value of a shorthand attribute as a JS expression, read through the rewrites of the template.
function addValue(b: CodeBuilder, attribute: Written): void {
  if (attribute.kind === 'static')
    b.add(JSON.stringify(attribute.text))
  else
    b.add('(').addSource(attribute.expression).add(')')
}

// The `title="..."` of `head(...)` as an island's `pageTitle(() => ..., false)` statement, or nothing without one.
export function addIslandShorthandTitle(b: CodeBuilder, head: ElementNode, text: Text, helper: string): void {
  const given = shorthandOf(head, 'title', text)

  if (given === undefined)
    return

  b.add(`${helper}(() => `)
  addValue(b, given)
  b.add(', false);\n')
}

// The shorthand attributes as a `head()` call of their own, ahead of the block's: a tag of the block replaces the attribute that sets the same one.
export function addShorthandGroup(b: CodeBuilder, call: string, head: ElementNode, text: Text, island: boolean): void {
  if (head.attributes.length === 0)
    return

  b.add(call)
  addShorthandTags(b, head, text, island)
  b.add(']);\n')
}

// The `head()` tags of the shorthand attributes as object literals, each followed by a comma, ahead of the block's own tags, which win over them. An island's title is marked, for the server to wrap as it does the island's.
export function addShorthandTags(b: CodeBuilder, head: ElementNode, text: Text, island: boolean): void {
  for (const attribute of head.attributes) {
    if (attribute.kind === 'spread')
      continue

    const name = text(attribute.name)
    const shape = HEAD_SHORTHAND.get(name)

    if (!shape || (attribute.kind === 'boolean' && name !== 'noindex'))
      continue

    const [key, match] = shape.match ?? []
    const conditional = name === 'noindex' && attribute.kind !== 'static'
    const value = () => attribute.kind === 'boolean' ? b.add('true') : addValue(b, attribute)

    if (conditional) {
      b.add('...(')
      value()
      b.add(' ? [')
    }

    b.add(`{ tag: ${JSON.stringify(shape.tag)}, props: { ${island && name === 'title' ? '"island": true, ' : ''}`)

    if (shape.prop === undefined) {
      b.add('"children": ')
      value()
    }
    else {
      b.add(`${JSON.stringify(key)}: ${JSON.stringify(match)}, ${JSON.stringify(shape.prop)}: `)

      if (name === 'noindex')
        b.add('"noindex"')
      else
        value()
    }

    b.add(' } }')
    b.add(conditional ? '] : []), ' : ', ')
  }
}
