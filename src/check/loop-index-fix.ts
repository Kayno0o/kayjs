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

// The fix an `unkeyed-rows` lint offers on the list of a `for` at `span`: `key={i}`, with the index added to the loop when it has none.
export function positionalKeyFix(source: string, span: Span | undefined): Fix[] | undefined {
  if (span === undefined)
    return undefined

  let found: Fix[] | undefined

  visitNodes(parseKay(source).template, (node) => {
    if (node.kind !== 'for' || node.each.start !== span.start || node.key)
      return

    const unused = source.slice(node.item.start, node.item.end) === 'i' ? 'index' : 'i'
    const index = node.index ? source.slice(node.index.start, node.index.end) : unused
    const edits = [...node.index ? [] : [{ start: node.item.end, end: node.item.end, text: `, ${index}` }], { start: node.each.end, end: node.each.end, text: ` key={${index}}` }]

    found = [{ title: `Match the rows by position, \`key={${index}}\``, edits, safe: false }]
  })

  return found
}
