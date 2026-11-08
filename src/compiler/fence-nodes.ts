import type { Node } from 'oxc-parser'
import type { NodeOfType } from './estree'

// The function nodes the fence checks tell apart, shared by the checks that walk a fence.

// A method is its `FunctionExpression` value in oxc's tree.
export type FunctionNode = NodeOfType<'ArrowFunctionExpression' | 'FunctionExpression' | 'FunctionDeclaration'>

export function isFunction(node: Node): node is FunctionNode {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration'
}

// Tells the calls and members of an optional chain, `a?.b.c()`, which the checks do not match: a node is one when its parent is the chain, or a chain part it is the callee or object of.
export function optionalParts(): (node: Node, parent: Node | undefined) => boolean {
  const parts = new Set<Node>()

  return (node, parent) => {
    const part = parent !== undefined && (parent.type === 'ChainExpression' || (parts.has(parent) && ((parent.type === 'CallExpression' && parent.callee === node) || (parent.type === 'MemberExpression' && parent.object === node))))

    if (part)
      parts.add(node)

    return part
  }
}
