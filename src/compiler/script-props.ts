import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import type { PropsDeclaration, ScriptAnalysis } from './script'
import { eachNode } from './each-node'
import { BINDABLE_TYPE, REMOVED_PROP_TYPES, typeDeclaration } from './script'
import { keyName } from './script-server'

export function withLeadingComments(statement: t.Statement, shift: (node: t.Node | t.Comment) => Span): Span {
  const span = shift(statement)
  const first = statement.leadingComments?.[0]

  return first ? { start: shift(first).start, end: span.end } : span
}

function isPropsCall(node: t.Node | null | undefined): node is t.CallExpression {
  return node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'props'
}

export function propsDeclaration(statement: t.Statement, body: t.Statement[], shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): PropsDeclaration | undefined {
  if (statement.type !== 'VariableDeclaration' || statement.declarations.length !== 1)
    return undefined

  const declarator = statement.declarations[0]!

  if (!isPropsCall(declarator.init))
    return undefined

  const typeArgument = declarator.init.typeParameters?.params[0]
  const bindable = bindableProps(typeArgument, body)

  reportSignalProps(typeArgument, body, shift, diagnostics)

  const declaration: PropsDeclaration = { statement: shift(statement), type: typeArgument && shift(typeArgument), bindings: [], bindable: [...bindable] }

  if (declarator.init.arguments.length > 0)
    diagnostics.push({ ...shift(declarator.init), message: '`props<T>()` takes no arguments', help: 'give defaults in the destructuring: `const { size = \'md\' } = props<T>()`' })

  if (!typeArgument)
    diagnostics.push({ ...shift(declarator.init), message: '`props()` needs the props type', help: '`props<{ title: string }>()`' })

  if (declarator.id.type === 'Identifier') {
    declaration.name = shift(declarator.id)

    return declaration
  }

  if (declarator.id.type !== 'ObjectPattern') {
    diagnostics.push({ ...shift(declarator.id), message: 'Props are read through a name or an object destructuring' })

    return declaration
  }

  const properties = declarator.id.properties

  for (const [index, property] of properties.entries()) {
    if (property.type === 'RestElement') {
      declaration.rest = shift(property.argument)

      continue
    }

    const key = keyName(property.key)
    const value = property.value
    const local = value.type === 'AssignmentPattern' ? value.left : value

    if (key === undefined || property.computed || local.type !== 'Identifier') {
      diagnostics.push({ ...shift(property), message: 'Props are destructured one level deep', help: 'destructure `{ todo }`, then read nested fields as `todo.title`' })

      continue
    }

    const next = properties[index + 1]
    const previous = properties[index - 1]
    const removal = next ? { start: shift(property).start, end: shift(next).start } : previous && { start: shift(previous).end, end: shift(property).end }

    declaration.bindings.push({ local: shift(local), key, fallback: value.type === 'AssignmentPattern' ? shift(value.right) : undefined, removal, bindable: bindable.has(key) })
  }

  return declaration
}

function kayImports(body: t.Statement[], wanted: Set<string>): Map<string, string> {
  const local = new Map<string, string>()

  for (const statement of body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay')
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        for (const name of wanted)
          local.set(`${specifier.local.name}.${name}`, name)

        continue
      }

      const imported = specifier.type === 'ImportSpecifier' ? specifier.imported : undefined
      const name = imported?.type === 'Identifier' ? imported.name : imported?.value

      if (name !== undefined && wanted.has(name))
        local.set(specifier.local.name, name)
    }
  }

  return local
}

interface PropType { key: string, options: (t.TSType | undefined)[] }

// The props of a props type, written inline or through an interface or a type alias of the script, each with the types it is written as (a union split into its members).
function propTypes(type: t.TSType | undefined, body: t.Statement[]): PropType[] {
  const named = type?.type === 'TSTypeReference' && type.typeName.type === 'Identifier' && !type.typeParameters ? type.typeName.name : undefined
  const declared = named === undefined ? undefined : body.map(typeDeclaration).find(declaration => declaration?.id.name === named)
  const literal = declared?.type === 'TSTypeAliasDeclaration' ? declared.typeAnnotation : type
  const literalMembers = literal?.type === 'TSTypeLiteral' ? literal.members : []
  const members = declared?.type === 'TSInterfaceDeclaration' ? declared.body.body : literalMembers
  const found: PropType[] = []

  for (const member of members) {
    if (member.type !== 'TSPropertySignature' || member.computed)
      continue

    const key = keyName(member.key)
    const written = member.typeAnnotation?.typeAnnotation

    if (key !== undefined)
      found.push({ key, options: written?.type === 'TSUnionType' ? written.types : [written] })
  }

  return found
}

// The `kay` name a type reference writes, as `Signal` or as `kay.Signal` through a namespace import.
function kayName(option: t.TSType | undefined, names: Map<string, string>): string | undefined {
  if (option?.type !== 'TSTypeReference')
    return undefined

  const { typeName } = option

  if (typeName.type === 'Identifier')
    return names.get(typeName.name)

  return typeName.left.type === 'Identifier' ? names.get(`${typeName.left.name}.${typeName.right.name}`) : undefined
}

// The props a props type writes as `Bindable<T>` from `kay`: read as values, and written by assigning. `Bindable<T> | undefined` is as bindable as `Bindable<T>`.
function bindableProps(type: t.TSType | undefined, body: t.Statement[]): Set<string> {
  const names = kayImports(body, new Set([BINDABLE_TYPE]))

  return new Set(propTypes(type, body).filter(({ options }) => options.some(option => kayName(option, names) !== undefined)).map(({ key }) => key))
}

// A prop typed `Signal<T>` or `Memo<T>` of `kay` is a plain value since 1.74, so it compiles and silently stops working as a getter.
function reportSignalProps(type: t.TSType | undefined, body: t.Statement[], shift: (node: t.Node) => Span, diagnostics: Diagnostic[]) {
  const names = kayImports(body, REMOVED_PROP_TYPES)

  if (names.size === 0)
    return

  for (const { key, options } of propTypes(type, body)) {
    for (const option of options) {
      const name = kayName(option, names)

      if (option === undefined || name === undefined)
        continue

      const help = name === 'Signal'
        ? `type it \`Bindable<T>\` and pass it as \`bind:${key}={...}\` when the component writes it, or a plain \`T\` when it only reads it`
        : `type it a plain \`T\` and pass the value, \`${key}={memo()}\``

      diagnostics.push({ ...shift(option), message: `prop \`${key}\` is typed \`${name}\`, but a prop is a plain value since 1.74`, help })
    }
  }
}

export function reportMisplacedProps(ast: t.File, analysis: ScriptAnalysis, shift: (node: t.Node) => Span) {
  const declared = analysis.props?.statement

  eachNode(ast.program, (node) => {
    if (!isPropsCall(node))
      return

    const span = shift(node)

    if (!declared || span.start < declared.start || span.end > declared.end)
      analysis.diagnostics.push({ ...span, message: '`props<T>()` is only valid as `const ... = props<T>()` at the top of the script' })

    return false
  })
}
