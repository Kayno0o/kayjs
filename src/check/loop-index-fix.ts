import type { Fix, Span } from '../compiler/ast'
import { visitNodes } from '../compiler/ast'
import { parseKay } from '../compiler/parser'

// The fixes of the last source asked about, by the start of each loop index, so a file with many unused names is parsed once.
let last: { source: string, fixes: Map<number, Fix[]> } | undefined

// The fix of an unread `for` loop index at `span`: dropping `, index`, which leaves the item and the key.
export function loopIndexFix(source: string, span: Span | undefined): Fix[] | undefined {
  if (span === undefined)
    return undefined

  if (last?.source !== source) {
    const fixes = new Map<number, Fix[]>()

    visitNodes(parseKay(source).template, (node) => {
      if (node.kind === 'for' && node.index)
        fixes.set(node.index.start, [{ title: `Remove \`${source.slice(node.index.start, node.index.end)}\``, edits: [{ start: node.item.end, end: node.index.end, text: '' }], safe: true }])
    })
    last = { source, fixes }
  }

  return last.fixes.get(span.start)
}
