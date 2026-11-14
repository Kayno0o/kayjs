import type { Node } from './ast'

// The node lists right under a node, in source order. Every template walker reaches nested nodes through this one switch, so a new kind of node fails to type-check here until it says what it holds.
export function childBlocks(node: Node): Node[][] {
  switch (node.kind) {
    case 'element':
    case 'slot':
    case 'snippet':
      return [node.children]
    case 'text':
      return [node.parts.filter(part => part.kind === 'element')]
    case 'if':
    case 'match':
      return [...(node.kind === 'if' ? node.branches : node.cases).map(branch => branch.children), ...node.fallback ? [node.fallback.children] : []]
    case 'for':
      return [node.children, node.fallback ?? []]
    case 'await':
      return [node.pending, node.resolved?.children ?? [], node.rejected?.children ?? []]
    case 'try':
      return [node.children, node.rejected?.children ?? []]
    case 'pending':
      return [node.children]
    case 'const':
    case 'error':
      return []
  }
}

// Calls `each` on every node of a template, nested ones included, in source order.
export function visitNodes(nodes: readonly Node[], each: (node: Node) => void): void {
  walkNodes(nodes, undefined, each)
}

// Like `visitNodes`, handing each node the context its parent answered for its children.
export function walkNodes<C>(nodes: readonly Node[], context: C, each: (node: Node, context: C) => C): void {
  for (const node of nodes) {
    const inner = each(node, context)

    for (const block of childBlocks(node))
      walkNodes(block, inner, each)
  }
}

// Whether `found` holds for a node of the template, nested ones included.
export function someNode(nodes: readonly Node[], found: (node: Node) => boolean): boolean {
  return nodes.some(node => found(node) || childBlocks(node).some(block => someNode(block, found)))
}
