import type { ParseResult } from '@babel/parser'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import { parse } from '@babel/parser'

export interface PropsBinding {
  // Name of a destructured prop, its key on the props object, and its default value when it has one.
  local: Span
  key: string
  fallback?: Span
}

export interface PropsDeclaration {
  statement: Span
  type?: Span
  // `const props = props<T>()` keeps a name; `const { a, b } = props<T>()` destructures.
  name?: Span
  bindings: PropsBinding[]
  rest?: Span
}

export interface ScriptAnalysis {
  hoisted: Span[]
  body: Span[]
  props?: PropsDeclaration
  diagnostics: Diagnostic[]
}

// Splits a component script into module-level code (imports, types) and the component body, and finds the props macro.
export function analyzeScript(source: string, script: Span | undefined): ScriptAnalysis {
  const analysis: ScriptAnalysis = { hoisted: [], body: [], diagnostics: [] }

  if (!script)
    return analysis

  const code = source.slice(script.start, script.end)
  let ast: ParseResult<t.File>

  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  }
  catch (error) {
    const at = script.start + ((error as { pos?: number }).pos ?? 0)

    analysis.diagnostics.push({ start: at, end: at + 1, message: (error as Error).message })

    return analysis
  }
  for (const error of ast.errors ?? []) {
    const at = script.start + ((error as unknown as { pos?: number }).pos ?? 0)

    analysis.diagnostics.push({ start: at, end: at + 1, message: error.reasonCode ?? 'Syntax error' })
  }
  const shift = (node: t.Node | t.Comment): Span => ({ start: script.start + node.start!, end: script.start + node.end! })
  let cursor = script.start

  for (const statement of ast.program.body) {
    const span = withLeadingComments(statement, shift)

    if (isHoisted(statement)) {
      analysis.hoisted.push(span)
    }
    else {
      if (span.start > cursor)
        analysis.body.push({ start: cursor, end: span.start })

      const props = propsDeclaration(statement, shift, analysis.diagnostics)

      if (props) {
        if (analysis.props)
          analysis.diagnostics.push({ ...props.statement, message: 'A component declares its props once' })

        analysis.props = props
      }
      else {
        if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportAllDeclaration')
          analysis.diagnostics.push({ ...span, message: 'A component script exports only types; values belong in a `.ts` module' })

        analysis.body.push(span)
      }
    }

    cursor = span.end
  }

  if (cursor < script.end)
    analysis.body.push({ start: cursor, end: script.end })

  reportMisplacedProps(ast, analysis, shift)

  return analysis
}

function isHoisted(statement: t.Statement): boolean {
  if (statement.type === 'ImportDeclaration' || statement.type === 'TSTypeAliasDeclaration' || statement.type === 'TSInterfaceDeclaration')
    return true

  if (statement.type !== 'ExportNamedDeclaration')
    return false

  if (statement.exportKind === 'type')
    return true

  return statement.declaration?.type === 'TSTypeAliasDeclaration' || statement.declaration?.type === 'TSInterfaceDeclaration'
}

function withLeadingComments(statement: t.Statement, shift: (node: t.Node | t.Comment) => Span): Span {
  const span = shift(statement)
  const first = statement.leadingComments?.[0]

  return first ? { start: shift(first).start, end: span.end } : span
}

function isPropsCall(node: t.Node | null | undefined): node is t.CallExpression {
  return node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'props'
}

function propsDeclaration(statement: t.Statement, shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): PropsDeclaration | undefined {
  if (statement.type !== 'VariableDeclaration' || statement.declarations.length !== 1)
    return undefined

  const declarator = statement.declarations[0]!

  if (!isPropsCall(declarator.init))
    return undefined

  const typeArgument = declarator.init.typeParameters?.params[0]
  const declaration: PropsDeclaration = { statement: shift(statement), type: typeArgument && shift(typeArgument), bindings: [] }

  if (declarator.init.arguments.length > 0)
    diagnostics.push({ ...shift(declarator.init), message: '`props<T>()` takes no arguments; give defaults in the destructuring: `const { size = \'md\' } = props<T>()`' })

  if (!typeArgument)
    diagnostics.push({ ...shift(declarator.init), message: '`props()` needs the props type: `props<{ title: string }>()`' })

  if (declarator.id.type === 'Identifier') {
    declaration.name = shift(declarator.id)

    return declaration
  }

  if (declarator.id.type !== 'ObjectPattern') {
    diagnostics.push({ ...shift(declarator.id), message: 'Props are read through a name or an object destructuring' })

    return declaration
  }

  for (const property of declarator.id.properties) {
    if (property.type === 'RestElement') {
      declaration.rest = shift(property.argument)

      continue
    }

    const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : undefined
    const value = property.value
    const local = value.type === 'AssignmentPattern' ? value.left : value

    if (key === undefined || property.computed || local.type !== 'Identifier') {
      diagnostics.push({ ...shift(property), message: 'Destructure props one level deep (`{ todo }`), then read nested fields as `todo.title`' })

      continue
    }

    declaration.bindings.push({ local: shift(local), key, fallback: value.type === 'AssignmentPattern' ? shift(value.right) : undefined })
  }

  return declaration
}

function reportMisplacedProps(ast: t.File, analysis: ScriptAnalysis, shift: (node: t.Node) => Span) {
  const declared = analysis.props?.statement
  const visit = (node: t.Node | null | undefined) => {
    if (!node || typeof node.type !== 'string')
      return

    if (isPropsCall(node)) {
      const span = shift(node)

      if (!declared || span.start < declared.start || span.end > declared.end)
        analysis.diagnostics.push({ ...span, message: '`props<T>()` is only valid as `const ... = props<T>()` at the top of the script' })

      return
    }

    for (const key of Object.keys(node) as (keyof t.Node)[]) {
      if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'loc')
        continue

      const value = node[key] as unknown

      if (Array.isArray(value)) {
        for (const child of value)
          visit(child as t.Node)
      }
      else if (value && typeof value === 'object') {
        visit(value as t.Node)
      }
    }
  }

  visit(ast.program)
}
