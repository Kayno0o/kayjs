import type { Node } from './estree'
import type { RewriteInput, Rewrites } from './rewrite-types'
import type { Binding, Path } from './scope'
import { tagPosition } from './rewrite-reads'

const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'])

// Whether an expression can hold text: a string or a template, alone or as a branch.
function holdsText(node: Node | null | undefined): boolean {
  if (!node)
    return false

  if (node.type === 'Literal')
    return typeof node.value === 'string'

  if (node.type === 'ConditionalExpression')
    return holdsText(node.consequent) || holdsText(node.alternate)

  if (node.type === 'LogicalExpression')
    return holdsText(node.left) || holdsText(node.right)

  return node.type === 'TemplateLiteral' || (WRAPPERS.has(node.type) && holdsText((node as { expression: Node }).expression))
}

// The members of a type the component's props are written as, a named one found among the script's declarations.
function membersOf(type: Node | undefined, program: Node | undefined): Node[] {
  if (type?.type === 'TSTypeLiteral')
    return type.members

  if (type?.type !== 'TSTypeReference' || type.typeName.type !== 'Identifier' || program?.type !== 'Program')
    return []

  const { name } = type.typeName

  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type === 'TSInterfaceDeclaration' && declaration.id.name === name)
      return declaration.body.body

    if (declaration?.type === 'TSTypeAliasDeclaration' && declaration.id.name === name)
      return membersOf(declaration.typeAnnotation, program)
  }

  return []
}

// Whether a type can be text: `string`, a string literal or a template, alone or in a union; a function type returning one is no text.
function textType(node: Node | undefined): boolean {
  if (node?.type === 'TSUnionType' || node?.type === 'TSIntersectionType')
    return node.types.some(textType)

  if (node?.type === 'TSParenthesizedType')
    return textType(node.typeAnnotation)

  return node?.type === 'TSStringKeyword' || node?.type === 'TSTemplateLiteralType' || (node?.type === 'TSLiteralType' && node.literal.type === 'Literal' && typeof node.literal.value === 'string')
}

// Whether the type a prop is declared with can be text.
function propHoldsText(binding: Binding, key: string): boolean {
  let path: Path | null = binding.path

  while (path && !path.isFunction())
    path = path.parentPath

  const param = path?.node && 'params' in path.node ? path.node.params[0] : undefined
  const annotation = param?.type === 'Identifier' ? param.typeAnnotation?.typeAnnotation : undefined
  let top = path

  while (top?.parentPath)
    top = top.parentPath

  const program = top?.node
  const member = membersOf(annotation, program).find(candidate => candidate.type === 'TSPropertySignature' && ((candidate.key.type === 'Identifier' && candidate.key.name === key) || (candidate.key.type === 'Literal' && candidate.key.value === key)))

  return member?.type === 'TSPropertySignature' && textType(member.typeAnnotation?.typeAnnotation)
}

// A component tag in the browser that can hold text, which names an element, opens as `KayDynamic`, the code that builds one loading only for a component that can hold it: a prop typed with `string` and a script `const` written as a string. A component value costs nothing more.
// The server's `component` takes a string for any value, and type checking keeps the tag as written.
export function markTagValue(path: Path, input: RewriteInput, rewrites: Rewrites): void {
  const name = (path.node as { name: string }).name
  const binding = path.scope.getBinding(name)
  const start = input.map.isExact(path.node.start) ? input.map.toSource(path.node.start) : undefined

  if (!input.dom || !binding || start === undefined || !path.isReferencedIdentifier() || tagPosition(path) !== 'opening')
    return

  const declared = binding.path.node
  const prop = input.sites.props.get(binding.identifier.start)
  const text = prop ? propHoldsText(binding, prop.binding.key) : declared.type === 'VariableDeclarator' && declared.id.type === 'Identifier' && holdsText(declared.init)

  if (text)
    rewrites.set(start, { ...rewrites.get(start), end: start + name.length, dynamic: true })
}
