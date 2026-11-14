import type { ElementNode, Span } from './ast'
import type { CodeBuilder } from './mapping'

type Text = (span: Span) => string

// The text lines of a head tag as one string expression.
export function emitHeadText(b: CodeBuilder, element: ElementNode): void {
  const lines = element.children.filter(child => child.kind === 'text')

  b.add('""')
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

// The tag `head()` takes: `{ tag: 'meta', props: { name: 'description', content: (description) } }`. The server tells the browser how to wrap the title an island goes on setting.
export function emitHeadTag(b: CodeBuilder, element: ElementNode, text: Text, island: boolean): void {
  b.wrap(element, () => {
    b.add(`{ tag: ${JSON.stringify(element.name)}, props: { `)

    if (element.name === 'title' && island)
      b.add('"island": true, ')

    if (element.classes.length > 0)
      b.add(`"class": ${JSON.stringify(element.classes.map(span => text(span)).join(' '))}, `)

    if (element.id)
      b.add(`"id": ${JSON.stringify(text(element.id))}, `)

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread') {
        b.add('...(').addSource(attribute.expression).add('), ')

        continue
      }

      b.add(`${JSON.stringify(text(attribute.name))}: `)

      if (attribute.kind === 'static')
        b.add(JSON.stringify(attribute.text))
      else if (attribute.kind === 'expression')
        b.add('(').addSource(attribute.expression).add(')')
      else
        b.add('true')

      b.add(', ')
    }

    if (element.children.some(child => child.kind === 'text')) {
      b.add('"children": ')
      emitHeadText(b, element)
    }

    b.add(' } }')
  })
}
