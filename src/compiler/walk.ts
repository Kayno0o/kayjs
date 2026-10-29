import type * as t from '@babel/types'
import type { NodeOfType, Path } from './scope'
import { FUNCTION_TYPES, VISITOR_KEYS } from './babel-shapes'
import { analyze } from './scope'

// A handler that returns `'stop'` ends the walk, as `path.stop()` does in Babel.
type Handler<N extends t.Node> = (path: Path<N>) => void | 'stop'

// What a walk calls for a node: `enter` for every node, then the handler of its type, then `Function` and `ReferencedIdentifier`, the aliases of Babel's visitors that kay's passes use.
export type Visitor = { [Type in t.Node['type']]?: Handler<NodeOfType<Type>> } & {
  enter?: Handler<t.Node>
  Function?: Handler<t.Function>
  ReferencedIdentifier?: Handler<t.Identifier | t.JSXIdentifier>
}

type AnyHandler = ((path: Path) => void | 'stop') | undefined

function visit(path: Path, visitor: Visitor): boolean {
  const handlers = visitor as Record<string, AnyHandler>

  if (handlers.enter?.(path) === 'stop' || handlers[path.node.type]?.(path) === 'stop')
    return true

  if (handlers.Function && FUNCTION_TYPES.has(path.node.type) && handlers.Function(path) === 'stop')
    return true

  if (handlers.ReferencedIdentifier && path.isReferencedIdentifier() && handlers.ReferencedIdentifier(path) === 'stop')
    return true

  return descend(path, visitor)
}

function descend(path: Path, visitor: Visitor): boolean {
  return path.children.some(child => visit(child, visitor))
}

// Visits what is under a path, the path itself left out, as `path.traverse` does.
export function traverse(path: Path, visitor: Visitor): void {
  descend(path, visitor)
}

// Walks a fence with kay's scope pass, false when the scope refuses a name declared twice, as an import and a `const` an edit passes through.
export function walkScope(ast: t.File, visitor: Visitor): boolean {
  try {
    visit(analyze(ast).program, visitor)

    return true
  }
  catch (error) {
    if (!(error instanceof TypeError && error.message.startsWith('Duplicate declaration')))
      throw error

    return false
  }
}

// Visits every node under `node`, parents first, in the order Babel's traversal meets them and with no scope.
export function eachDescendant(node: t.Node, visitNode: (node: t.Node, parent: t.Node) => void): void {
  for (const key of VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, t.Node | (t.Node | null)[] | null>)[key]

    for (const inner of Array.isArray(child) ? child : [child]) {
      if (inner) {
        visitNode(inner, node)
        eachDescendant(inner, visitNode)
      }
    }
  }
}
