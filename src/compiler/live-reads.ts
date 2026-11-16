import type { Span } from './ast'
import type { Node, NodeOfType } from './estree'
import type { RewriteInput } from './rewrite-types'
import type { Binding, Path } from './scope'
import { eachNode } from './each-node'
import { isFunction } from './fence-nodes'
import { lintLevels } from './lints'
import { SELF } from './names'
import { sourceEnds } from './rewrite-reads'

// A prop named like an initial value is read once on purpose, and so is a callback (`onChange`), which a component reads to tell whether one was given.
export const INITIAL_PROP = /^(?:(?:initial|default)(?![a-z])|on[A-Z])/
// The TypeScript nodes that wrap a value rather than describe a type.
export const VALUE_TS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression'])

// Whether an identifier names a variable at its parent, rather than a member, a key or a label.
function isReference(node: NodeOfType<'Identifier'>, parent: Node | undefined): boolean {
  if (parent?.type === 'MemberExpression')
    return parent.object === node || parent.computed

  if (parent?.type === 'Property' || parent?.type === 'PropertyDefinition' || parent?.type === 'MethodDefinition')
    return parent.value === node || parent.computed

  return parent?.type !== 'LabeledStatement' && parent?.type !== 'BreakStatement' && parent?.type !== 'ContinueStatement' && parent?.type !== 'ExportSpecifier'
}

// The reads of a value a top-level declaration derives from: the identifiers `isLive` accepts that its initializer reads as a value.
// The test of a condition, the arguments of a call or `new`, a write target, a class and a function's body choose or build something once and are left out, as is `id ?? uid()`; so a declaration reading none of them is no derivation.
export function derivedReads(init: Node, isLive: (name: string) => boolean): NodeOfType<'Identifier'>[] {
  const found: NodeOfType<'Identifier'>[] = []
  const seen = new Set<number>()

  const reads = (node: Node, parent: Node | undefined): boolean | void => {
    if (isFunction(node) || node.type === 'ClassBody' || (node.type.startsWith('TS') && !VALUE_TS.has(node.type)))
      return false

    // Only the callee of a call and the target of `new` are read; the arguments choose what is built.
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      eachNode(node.callee, reads, node)

      return false
    }

    if (node.type === 'ConditionalExpression') {
      eachNode(node.consequent, reads, node)
      eachNode(node.alternate, reads, node)

      return false
    }

    if (node.type === 'AssignmentExpression') {
      eachNode(node.right, reads, node)

      return false
    }

    if (node.type === 'UpdateExpression')
      return false

    // `id ?? uid()`: an id is made once.
    if (node.type === 'LogicalExpression' && node.operator === '??' && node.left.type === 'Identifier' && node.right.type === 'CallExpression' && node.right.callee.type === 'Identifier' && node.right.callee.name === 'uid')
      return false

    if (node.type !== 'Identifier' || !isLive(node.name) || !isReference(node, parent) || seen.has(node.start))
      return true

    seen.add(node.start)
    found.push(node)

    return true
  }

  eachNode(init, reads)

  return found
}

// A top-level `const` naming one value, with nothing suspending in it: the compiler computes it by a memo in the browser, so it follows what it reads.
export function derivable(statement: NodeOfType<'VariableDeclaration'>, declarator: NodeOfType<'VariableDeclarator'>): boolean {
  return statement.kind === 'const' && declarator.id.type === 'Identifier' && declarator.init != null && !suspends(declarator.init)
}

// Whether a node holds an `await` or a `yield` outside a function, which cannot move into the function a derived value is computed by.
export function suspends(node: Node): boolean {
  let found = false

  eachNode(node, (inner) => {
    if (isFunction(inner))
      return false

    if (inner.type === 'AwaitExpression' || inner.type === 'YieldExpression' || (inner.type === 'ForOfStatement' && inner.await))
      found = true

    return !found
  })

  return found
}

// Where the initializer of a top-level `const` of the component runs from and to in the source, when the browser computes it by a memo: it reads a prop, a signal or a derived `const` as a value, and no `kay-allow once-read-prop` comment says its first value is meant.
export function derivedSpan(path: Path<NodeOfType<'VariableDeclarator'>>, live: ReadonlySet<Binding>, input: RewriteInput): (Span & { binding: Binding }) | undefined {
  const { id, init } = path.node
  const statement = path.parentPath
  const { map } = input
  const binding = id.type === 'Identifier' ? path.scope.getBinding(id.name) : undefined

  if (!binding || id.type !== 'Identifier' || !init || path.scope.node.type !== 'FunctionDeclaration' || path.scope.node.id?.name !== SELF || statement?.parentPath?.node.type !== 'BlockStatement' || !statement.is('VariableDeclaration') || !derivable(statement.node, path.node))
    return undefined

  const reads = derivedReads(init, (name) => {
    const binding = path.scope.getBinding(name)

    return binding !== undefined && live.has(binding)
  })

  const span = sourceEnds(map, init)

  if (reads.length === 0 || !span)
    return undefined

  // The comment of the lint says the first value is meant, which it still is.
  const levelAt = input.source === undefined ? undefined : lintLevels(input.source)

  if (levelAt && [init, ...reads].some(node => map.isExact(node.start) && levelAt('once-read-prop', map.toSource(node.start)!) === 'allow'))
    return undefined

  return { ...span, binding }
}
