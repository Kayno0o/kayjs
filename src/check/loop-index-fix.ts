import type { Fix, Span } from '../compiler/ast'
import { visitNodes } from '../compiler/ast'
import { parseKay } from '../compiler/parser'

// The fix of an unread `for` loop index at `span`: dropping `, index`, which leaves the item and the key.
export function loopIndexFix(source: string, span: Span | undefined): Fix[] | undefined {
  if (span === undefined)
    return undefined

  let fix: Fix[] | undefined

  visitNodes(parseKay(source).template, (node) => {
    if (node.kind === 'for' && node.index?.start === span.start)
      fix = [{ title: `Remove \`${source.slice(node.index.start, node.index.end)}\``, edits: [{ start: node.item.end, end: node.index.end, text: '' }], safe: true }]
  })

  return fix
}
