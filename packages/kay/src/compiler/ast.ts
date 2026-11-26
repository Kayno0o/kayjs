// The generic oxc AST walk every compiler pass shares, kept apart from the analyzer so the passes it calls can import it without a cycle.

import type { Node, Program } from 'oxc-parser'
import { visitorKeys } from 'oxc-parser'

export type AstNode = Node

export function computeJsxNodes(program: Program): WeakSet<Node> {
  const jsxNodes = new WeakSet<Node>()
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== 'object')
      return false
    if (Array.isArray(node)) {
      let any = false
      for (let i = 0; i < node.length; i++) {
        if (visit(node[i]))
          any = true
      }
      return any
    }
    const ast = node as Node
    const type = ast.type
    if (typeof type !== 'string')
      return false
    let found = type === 'JSXElement' || type === 'JSXFragment'
    const keys = visitorKeys[type]
    if (keys !== undefined) {
      const rec = ast as unknown as Record<string, unknown>
      for (let i = 0; i < keys.length; i++) {
        const val = rec[keys[i]!]
        if (val !== null && typeof val === 'object' && visit(val))
          found = true
      }
    }
    else {
      for (const [key, val] of Object.entries(ast)) {
        if (key === 'start' || key === 'end' || key === 'type')
          continue
        if (val !== null && typeof val === 'object' && visit(val))
          found = true
      }
    }
    if (found)
      jsxNodes.add(ast)
    return found
  }
  visit(program)
  return jsxNodes
}

/** Visits `node` and its children depth first; a visitor returning `false` skips the children of that node. */
export function walk(node: unknown, visit: (node: Node) => boolean | void): void {
  if (node === null || typeof node !== 'object')
    return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++)
      walk(node[i], visit)
    return
  }
  const ast = node as Node
  const type = ast.type
  if (typeof type !== 'string')
    return
  if (visit(ast) === false)
    return
  const keys = visitorKeys[type]
  if (keys !== undefined) {
    const rec = ast as unknown as Record<string, unknown>
    for (let i = 0; i < keys.length; i++) {
      const val = rec[keys[i]!]
      if (val !== null && typeof val === 'object')
        walk(val, visit)
    }
    return
  }
  for (const [key, val] of Object.entries(ast)) {
    if (key === 'start' || key === 'end' || key === 'type')
      continue
    if (val !== null && typeof val === 'object')
      walk(val, visit)
  }
}
