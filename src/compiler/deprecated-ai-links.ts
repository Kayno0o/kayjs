import type { Details, ElementNode, Span } from './ast'
import type { Named } from './deprecated-ui-props'

type Report = (span: Span, message: string, details: Details) => void

const PLAIN_PATH = /^[\w$]+(?:\.[\w$]+)*$/

const MESSAGE = 'Which links open in a new tab is `newTab` since 1.105, as the links of kayjs-ui take it: `true`, `false` or `\'auto\'`, which opens a link to a page of this site in place'

// `Chat`'s `links` and `Sources`' `here`, `newTab` since 1.105: `links="apart"` is `newTab={true}`, `links="here"` and `here` are `newTab="auto"`. Found on a component bound to the library's file; the fix offers none beside a `newTab` already written, or a value it cannot read.
export function deprecatedAiLinks(element: ElementNode, file: string, text: (span: Span) => string, report: Report): void {
  if (file !== 'ai/chat' && file !== 'ai/chat-sources')
    return

  const attributes = element.attributes.filter((attribute): attribute is Named => attribute.kind !== 'spread')
  const old = attributes.find(attribute => text(attribute.name) === (file === 'ai/chat' ? 'links' : 'here'))

  if (old === undefined)
    return

  const replacement = file === 'ai/chat' ? links(old) : here(old, text)

  if (attributes.some(attribute => text(attribute.name) === 'newTab') || replacement === undefined) {
    report(old.name, MESSAGE, { help: 'Write `newTab` and drop the old prop' })

    return
  }

  const start = old.kind === 'expression' && old.shorthand ? old.shorthand.start : old.name.start
  const end = endOf(old)

  report(old.name, MESSAGE, { help: 'Write `newTab`', fixes: [{ title: 'Write `newTab`', safe: true, edits: [{ start, end, text: replacement }] }] })
}

function endOf(attribute: Named): number {
  if (attribute.kind === 'static')
    return attribute.value.end + 1

  if (attribute.kind === 'expression')
    return (attribute.shorthand ?? { end: attribute.expression.end + 1 }).end

  return attribute.name.end
}

const LINKS: Record<string, string> = { apart: 'newTab={true}', here: 'newTab="auto"' }

function links(attribute: Named): string | undefined {
  return attribute.kind === 'static' ? LINKS[attribute.text] : undefined
}

function here(attribute: Named, text: (span: Span) => string): string | undefined {
  if (attribute.kind === 'boolean')
    return 'newTab="auto"'

  if (attribute.kind === 'expression') {
    const value = attribute.shorthand ? text(attribute.name) : text(attribute.expression).trim()

    // Anything but a name or a member path is parenthesised, so a conditional keeps its meaning under the new one.
    return `newTab={${PLAIN_PATH.test(value) ? value : `(${value})`} ? 'auto' : true}`
  }

  return undefined
}
