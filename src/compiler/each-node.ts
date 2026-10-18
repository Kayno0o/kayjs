import type * as t from '@babel/types'

// The keys of a Babel node that say where it is written, or hold its comments, rather than its children.
const NOT_CHILDREN = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments'])

// Visits every node under `node`, parents first, its comments left out; the visitor returns false to skip what is under one.
export function eachNode(node: t.Node | null | undefined, visit: (node: t.Node, parent: t.Node | undefined) => boolean | void, parent?: t.Node): void {
  if (!node || typeof node.type !== 'string' || visit(node, parent) === false)
    return

  for (const key of Object.keys(node)) {
    if (NOT_CHILDREN.has(key))
      continue

    const value = node[key as keyof t.Node] as unknown

    if (Array.isArray(value)) {
      for (const child of value)
        eachNode(child as t.Node, visit, node)
    }
    else if (value !== null && typeof value === 'object') {
      eachNode(value as t.Node, visit, node)
    }
  }
}
