import type { RewriteInput, Rewrites } from './rewrite-types'
import type { Path } from './scope'
import { tagPosition } from './rewrite-reads'

const FUNCTION_VALUES = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'])

// A component tag naming anything the module does not import or declare as a function or a class may hold text, which names an element, so it opens as `KayDynamic` on the server and in the browser alike.
// Type checking keeps the tag as written, its props checked against the component's.
export function markTagValue(path: Path, input: RewriteInput, rewrites: Rewrites): void {
  const name = (path.node as { name: string }).name
  const binding = path.scope.getBinding(name)
  const declared = binding?.path.node
  const start = input.map.isExact(path.node.start) ? input.map.toSource(path.node.start) : undefined

  if (input.values || !binding || start === undefined || !path.isReferencedIdentifier() || tagPosition(path) !== 'opening' || binding.kind === 'module' || binding.kind === 'hoisted')
    return

  if (declared?.type === 'ClassDeclaration' || declared?.type === 'FunctionDeclaration' || (declared?.type === 'VariableDeclarator' && FUNCTION_VALUES.has(declared.init?.type ?? '')))
    return

  rewrites.set(start, { ...rewrites.get(start), end: start + name.length, dynamic: true })
}
