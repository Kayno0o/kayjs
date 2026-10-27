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

// The modules a script imports or re-exports from, as Bun's `scanImports` lists them, for a lint under Node where its transpiler is missing: a type-only import is left out, and so is a dynamic import or a `require`, which no template reads a name of.
export function importedModules(source: string): string[] {
  const modules: string[] = []

  for (const statement of parseModule(source, false)?.program.body ?? []) {
    if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type' && !allTypes(statement.specifiers))
      modules.push(statement.source.value)
    else if ((statement.type === 'ExportAllDeclaration' || (statement.type === 'ExportNamedDeclaration' && !allTypes(statement.specifiers))) && statement.source && statement.exportKind !== 'type')
      modules.push(statement.source.value)
  }

  return modules
}

// `import { type A, type B }`, which Bun drops as it would `import type`.
function allTypes(specifiers: t.Node[]): boolean {
  return specifiers.length > 0 && specifiers.every(specifier => (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') || (specifier.type === 'ExportSpecifier' && specifier.exportKind === 'type'))
}

// What a component importing a module reads of it: its signals and memos, and the names it exports as literal data. The module is parsed once, and only when it exports something.
export function moduleKinds(source: string, jsx = false, reexported?: Reexported): Record<string, SignalKind | 'data'> {
  const ast = source.includes('export') ? parseModule(source, jsx) : undefined

  return ast ? { ...Object.fromEntries(dataIn(ast, reexported).map(name => [name, 'data' as const])), ...NAMES_KAY.test(source) ? signalsIn(ast) : {} } : {}
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

// The names a module exports as data, whose values are all strings, numbers, booleans or null: what a component reading one passes an island as data, not as a function.
// That is `export const name = <literal>`, a `const` exported by `export { name }`, an `export default` of a literal or of such a `const`, and what `export { name } from` and `export * from` take from a module `reexported` reads.
export function moduleData(source: string, jsx = false, reexported?: Reexported): string[] {
  const ast = source.includes('export') ? parseModule(source, jsx) : undefined

  return ast ? dataIn(ast, reexported) : []
}

// What another module exports, by the specifier a re-export names it with.
export type Reexported = (specifier: string) => Record<string, SignalKind | 'data'>

// The names of a JSON file's value, which is all data: its default export and each key of an object, which Bun lets a component import by name.
export function jsonKinds(source: string): Record<string, 'data'> {
  try {
    const value: unknown = JSON.parse(source)

    return { default: 'data', ...Object.fromEntries(value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).map(key => [key, 'data' as const]) : []) }
  }
  catch {
    return {}
  }
}

function exportedName(node: t.Identifier | t.StringLiteral): string {
  return node.type === 'Identifier' ? node.name : node.value
}

// The names a binding pattern declares, `a` and `b` in `const { a, x: [b] } = ...`.
function boundNames(pattern: t.Node | null | undefined, into: Set<string>): void {
  if (!pattern)
    return

  if (pattern.type === 'Identifier') {
    into.add(pattern.name)
  }
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties)
      boundNames(property.type === 'RestElement' ? property.argument : property.value, into)
  }
  else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements)
      boundNames(element, into)
  }
  else if (pattern.type === 'AssignmentPattern') {
    boundNames(pattern.left, into)
  }
  else if (pattern.type === 'RestElement') {
    boundNames(pattern.argument, into)
  }
}

// The names a module exports itself, which win over the same name in an `export *`.
function ownExports(ast: t.File): Set<string> {
  const own = new Set<string>()

  for (const statement of ast.program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      own.add('default')
    }
    else if (statement.type === 'ExportNamedDeclaration') {
      const declaration = statement.declaration

      if (declaration?.type === 'VariableDeclaration') {
        for (const { id } of declaration.declarations)
          boundNames(id, own)
      }
      else if (declaration && 'id' in declaration && declaration.id?.type === 'Identifier') {
        own.add(declaration.id.name)
      }

      for (const specifier of statement.specifiers)
        own.add(specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value)
    }
  }

  return own
}

function dataIn(ast: t.File, reexported?: Reexported): string[] {
  const found = new Set<string>()
  const local = new Set<string>()
  const stars = new Map<t.ExportAllDeclaration, Record<string, SignalKind | 'data'>>()
  const starred = new Map<string, number>()

  for (const statement of ast.program.body) {
    if (statement.type !== 'ExportAllDeclaration' || statement.exportKind === 'type')
      continue

    const names = reexported?.(statement.source.value) ?? {}

    stars.set(statement, names)

    for (const name of Object.keys(names))
      starred.set(name, (starred.get(name) ?? 0) + 1)
  }

  const own = stars.size === 0 ? new Set<string>() : ownExports(ast)

  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const')
      continue

    for (const { id, init } of declaration.declarations) {
      if (id.type !== 'Identifier' || !init || !isDataLiteral(init))
        continue

      local.add(id.name)

      if (statement.type === 'ExportNamedDeclaration')
        found.add(id.name)
    }
  }

  for (const statement of ast.program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      const value = statement.declaration

      if (value.type === 'Identifier' ? local.has(value.name) : isDataLiteral(value))
        found.add('default')
    }
    else if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
      // A name two stars share is ambiguous, so the module does not export it.
      for (const [name, kind] of Object.entries(stars.get(statement) ?? {})) {
        if (kind === 'data' && name !== 'default' && !own.has(name) && starred.get(name) === 1)
          found.add(name)
      }
    }
    else if (statement.type === 'ExportNamedDeclaration' && !statement.declaration && statement.exportKind !== 'type') {
      const from = statement.source ? reexported?.(statement.source.value) : undefined

      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ExportSpecifier' || specifier.exportKind === 'type')
          continue

        const name = specifier.local.name

        if (statement.source ? from?.[name] === 'data' : local.has(name))
          found.add(exportedName(specifier.exported))
      }
    }
  }

  return [...found]
}
