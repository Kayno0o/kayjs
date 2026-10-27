import type * as t from '@babel/types'
import { parse } from '@babel/parser'

// A signal is written by assigning its name; a memo is only read; a live value is only read in the browser, the server changing it.
export type SignalKind = 'signal' | 'memo' | 'live'

// The signals and memos of each module a component imports, by the specifier it imports them with.
// A name a module exports as a literal of strings and numbers is `data`: no function, so a component passing one to an island is not promoted for it.
export type ImportedSignals = Record<string, Record<string, SignalKind | 'data'>>

// The signal kind of an imported name, which `data` is not.
export function signalKind(kind: SignalKind | 'data' | undefined): SignalKind | undefined {
  return kind === 'data' ? undefined : kind
}

export const MADE: Record<string, SignalKind> = { signal: 'signal', persisted: 'signal', linked: 'signal', queryParam: 'signal', memo: 'memo', debounced: 'memo', live: 'live' }
const NAMES_KAY = /["']kay["']/

// The names a module exports as `export const name = signal(...)`, or `persisted`, `linked`, `queryParam`, `memo`, `debounced` or `live`, called as imported from `kay`: what a component importing them writes by assigning, and reads by calling.
export function moduleSignals(source: string, jsx = false): Record<string, SignalKind> {
  const ast = NAMES_KAY.test(source) ? parseModule(source, jsx) : undefined

  return ast ? signalsIn(ast) : {}
}

function parseModule(source: string, jsx: boolean): t.File | undefined {
  try {
    return parse(source, { sourceType: 'module', attachComment: false, plugins: jsx ? ['typescript', 'jsx'] : ['typescript'] })
  }
  catch {
    return undefined
  }
}

// What a component importing a module reads of it: its signals and memos, and the names it exports as literal data. The module is parsed once, and only when it exports something.
export function moduleKinds(source: string, jsx = false): Record<string, SignalKind | 'data'> {
  const ast = source.includes('export') ? parseModule(source, jsx) : undefined

  return ast ? { ...Object.fromEntries(dataIn(ast).map(name => [name, 'data' as const])), ...NAMES_KAY.test(source) ? signalsIn(ast) : {} } : {}
}

function signalsIn(ast: t.File): Record<string, SignalKind> {
  const made = new Map<string, SignalKind>()
  const found: Record<string, SignalKind> = {}

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay' || statement.importKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      const imported = specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' ? specifier.imported : undefined
      const kind = imported && MADE[imported.type === 'Identifier' ? imported.name : imported.value]

      if (kind)
        made.set(specifier.local.name, kind)
    }
  }

  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : undefined

    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const')
      continue

    for (const { id, init } of declaration.declarations) {
      const kind = id.type === 'Identifier' && init?.type === 'CallExpression' && init.callee.type === 'Identifier' ? made.get(init.callee.name) : undefined

      if (kind)
        found[(id as t.Identifier).name] = kind
    }
  }

  return found
}

const SCALARS = new Set(['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral'])

// Whether an expression is plain data, a literal string, number, boolean or null, or an array or object of them, `as const` and `satisfies` aside: nothing in it can be a function. A literal another module mutates afterwards is still read as data.
function isDataLiteral(node: t.Node): boolean {
  if (SCALARS.has(node.type))
    return true

  if (node.type === 'TemplateLiteral')
    return node.expressions.length === 0

  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression')
    return isDataLiteral(node.expression)

  if (node.type === 'UnaryExpression')
    return (node.operator === '-' || node.operator === '+') && node.argument.type === 'NumericLiteral'

  if (node.type === 'ArrayExpression')
    return node.elements.every(element => element !== null && isDataLiteral(element))

  return node.type === 'ObjectExpression' && node.properties.every(property => property.type === 'ObjectProperty' && !property.shorthand && (!property.computed || property.key.type === 'StringLiteral' || property.key.type === 'NumericLiteral') && isDataLiteral(property.value))
}

// The names a module exports as `export const name = <literal>`, never `export { name }` or a re-export, whose values are all strings, numbers, booleans or null: what a component reading one passes an island as data, not as a function.
export function moduleData(source: string, jsx = false): string[] {
  const ast = source.includes('export') ? parseModule(source, jsx) : undefined

  return ast ? dataIn(ast) : []
}

function dataIn(ast: t.File): string[] {
  const found: string[] = []

  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : undefined

    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const')
      continue

    for (const { id, init } of declaration.declarations) {
      if (id.type === 'Identifier' && init && isDataLiteral(init))
        found.push(id.name)
    }
  }

  return found
}
