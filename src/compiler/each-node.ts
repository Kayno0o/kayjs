import type { Node } from './estree'
import { VISITOR_KEYS } from './estree'

// Visits every node under `node`, parents first, its comments left out; the visitor returns false to skip what is under one.
export function eachNode(node: Node | null | undefined, visit: (node: Node, parent: Node | undefined) => boolean | void, parent?: Node): void {
  if (!node || typeof node.type !== 'string' || visit(node, parent) === false)
    return

  for (const key of VISITOR_KEYS[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key]

    if (Array.isArray(value)) {
      for (const child of value)
        eachNode(child as Node | null, visit, node)
    }
    else if (value !== null && typeof value === 'object') {
      eachNode(value as Node, visit, node)
    }
  }
}
