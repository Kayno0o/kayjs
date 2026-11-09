import type { Details, Node } from './ast'

function elseStart(src: string, node: Node | undefined): number | undefined {
  if (node?.kind === 'if')
    return node.fallback?.start

  // A `for` keeps no span for its `else`, which sits on the line before the first node under it.
  if (node?.kind === 'for' && node.fallback)
    return src.lastIndexOf('else', node.fallback[0] ? src.lastIndexOf('\n', node.fallback[0].start) : node.end)

  return undefined
}

// Why an `else` has nothing to attach to: a second `else`, a line between it and its `if` or `for`, or no `if` at all.
export function strayElse(src: string, siblings: Node[], hasTest: boolean): Details & { message: string } {
  const previous = siblings.at(-1)
  const first = elseStart(src, previous)

  if (first !== undefined)
    return { message: hasTest ? '`else if` cannot follow an `else`' : 'An `if` or a `for` takes one `else`', related: [{ start: first, end: first + 4, label: 'the first `else`' }], help: '`else` ends the chain: put the `else if` lines before it' }

  const opener = siblings.findLast(node => (node.kind === 'if' || node.kind === 'for') && !node.fallback)

  if (previous && opener && opener !== previous)
    return { message: '`else` must directly follow its `if` or `for`, and a line sits between them', related: [{ start: previous.start, end: src.indexOf('\n', previous.start), label: 'this line separates them' }], help: 'move the `else` up under the `if`, or the line out from between them' }

  return { message: '`else` must directly follow an `if`, an `else if` or a `for` at the same indentation' }
}
