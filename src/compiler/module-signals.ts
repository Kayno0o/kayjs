import type { Node, NodeOfType, Program } from './estree'
import { parseProgram } from './estree'

// A signal is written by assigning its name; a memo is only read; a live value is only read in the browser, the server changing it; a persisted one is a signal the browser's storage holds, which makes a module's reader an island as a live value does.
export type SignalKind = 'signal' | 'memo' | 'live' | 'persisted'

// The signals and memos of each module a component imports, by the specifier it imports them with.
export type ImportedSignals = Record<string, Record<string, SignalKind>>

export const MADE: Record<string, SignalKind> = { signal: 'signal', persisted: 'signal', linked: 'signal', queryParam: 'signal', memo: 'memo', debounced: 'memo', throttled: 'memo', live: 'live' }
const NAMES_KAY = /["']kay["']/
const EXPORT = /\bexport\b/

// The entries `persisted` carries, one per storage.
export const PERSISTED_ENTRIES = new Set(['cookie', 'local', 'session', 'query'])

// The names a module exports as `export const name = signal(...)`, or `persisted`, `linked`, `queryParam`, `memo`, `debounced`, `throttled` or `live`, called as imported from `kay`: what a component importing them writes by assigning, and reads by calling.
export function moduleSignals(source: string, jsx = false): Record<string, SignalKind> {
  const ast = NAMES_KAY.test(source) ? parseModule(source, jsx) : undefined

  return ast ? signalsIn(ast) : {}
}

// A module's signals and what it hands on from other modules, from one parse that a module naming neither `kay` nor an export skips.
export function scanModule(source: string, jsx = false): { signals: Record<string, SignalKind>, links: ModuleLinks } {
  const ast = NAMES_KAY.test(source) || EXPORT.test(source) ? parseModule(source, jsx) : undefined

  return { signals: ast && NAMES_KAY.test(source) ? signalsIn(ast) : {}, links: ast ? linksIn(ast) : { stars: [], own: new Set(), names: [] } }
}

function parseModule(source: string, jsx: boolean): Program | undefined {
  try {
    return parseProgram(source, { lang: jsx ? 'tsx' : 'ts', semantic: true }).program
  }
  catch {
    return undefined
  }
}

// The modules a script imports or re-exports from, as Bun's `scanImports` lists them, for a lint under Node where its transpiler is missing: a type-only import is left out, and so is a dynamic import or a `require`, which no template reads a name of.
export function importedModules(source: string): string[] {
  const modules: string[] = []

  for (const statement of parseModule(source, false)?.body ?? []) {
    if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type' && !allTypes(statement.specifiers))
      modules.push(statement.source.value)
    else if ((statement.type === 'ExportAllDeclaration' || (statement.type === 'ExportNamedDeclaration' && !allTypes(statement.specifiers))) && statement.source && statement.exportKind !== 'type')
      modules.push(statement.source.value)
  }

  return modules
}

// `import { type A, type B }`, which Bun drops as it would `import type`.
function allTypes(specifiers: Node[]): boolean {
  return specifiers.length > 0 && specifiers.every(specifier => (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') || (specifier.type === 'ExportSpecifier' && specifier.exportKind === 'type'))
}

// The local name a call's callee makes a signal by: `signal` of `signal(...)`, and `persisted` of `persisted.local(...)`, `.session`, `.cookie` and `.query`, which make one as `persisted(...)` does.
function madeBy(callee: Node, persisted: Set<string>): string | undefined {
  if (callee.type === 'Identifier')
    return callee.name

  if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier')
    return undefined

  return PERSISTED_ENTRIES.has(callee.property.name) && persisted.has(callee.object.name) ? callee.object.name : undefined
}

function signalsIn(ast: Program): Record<string, SignalKind> {
  const made = new Map<string, SignalKind>()
  // The local names `persisted` is imported as.
  const persisted = new Set<string>()
  const found: Record<string, SignalKind> = {}

  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay' || statement.importKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      const imported = specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' ? specifier.imported : undefined
      const importedName = imported ? nameOf(imported) : undefined
      const kind = importedName === 'persisted' ? 'persisted' : MADE[importedName ?? '']

      if (kind)
        made.set(specifier.local.name, kind)

      if (importedName === 'persisted')
        persisted.add(specifier.local.name)
    }
  }

  // Every top-level `const` made by a signal call, exported or not, so an `export { name }` or an alias finds it.
  const locals = new Map<string, SignalKind>()

  for (const statement of ast.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const')
      continue

    for (const { id, init } of declaration.declarations) {
      const name = init?.type === 'CallExpression' ? madeBy(init.callee, persisted) : undefined
      const kind = init?.type === 'Identifier' ? locals.get(init.name) : made.get(name ?? '')

      if (id.type !== 'Identifier' || !kind)
        continue

      locals.set(id.name, kind)

      if (statement.type === 'ExportNamedDeclaration')
        found[id.name] = kind
    }
  }

  for (const statement of ast.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.source || statement.exportKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      const local = specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type' && specifier.local.type === 'Identifier' ? locals.get(specifier.local.name) : undefined

      if (local)
        found[nameOf(specifier.exported)] = local
    }
  }

  return found
}

function nameOf(node: Node): string {
  if (node.type === 'Identifier')
    return node.name

  return node.type === 'Literal' ? String(node.value) : ''
}

// What a module hands on from another: the names `export { a as b } from`, `export * from`, or an import it exports (`import { a } from`, then `export { a }` or `export const b = a`) take from the module they come from, for the build to look their kind up there.
export interface ModuleLinks {
  stars: string[]
  // Every name the module exports itself, which shadows the same name of a star re-export.
  own: Set<string>
  names: { exported: string, source: string, imported: string }[]
}

function linksIn(ast: Program): ModuleLinks {
  const links: ModuleLinks = { stars: [], own: new Set(), names: [] }
  const imports = new Map<string, { source: string, imported: string }>()

  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type')
        imports.set(specifier.local.name, { source: statement.source.value, imported: nameOf(specifier.imported) })
    }
  }

  for (const statement of ast.body) {
    if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type' && !statement.exported)
      links.stars.push(statement.source.value)

    if (statement.type === 'ExportNamedDeclaration' && statement.exportKind !== 'type')
      linkNamed(statement, imports, links)
  }

  return links
}

function linkNamed(statement: NodeOfType<'ExportNamedDeclaration'>, imports: Map<string, { source: string, imported: string }>, links: ModuleLinks): void {
  const declared = statement.declaration

  if (declared?.type === 'VariableDeclaration') {
    for (const { id } of declared.declarations) {
      if (id.type === 'Identifier')
        links.own.add(id.name)
    }
  }
  else if (declared && 'id' in declared && declared.id?.type === 'Identifier') {
    links.own.add(declared.id.name)
  }

  for (const specifier of statement.specifiers) {
    if (specifier.type !== 'ExportSpecifier' || specifier.exportKind === 'type')
      continue

    links.own.add(nameOf(specifier.exported))

    const local = specifier.local.type === 'Identifier' ? imports.get(specifier.local.name) : undefined
    const from = statement.source ? { source: statement.source.value, imported: nameOf(specifier.local) } : local

    if (from)
      links.names.push({ exported: nameOf(specifier.exported), ...from })
  }

  for (const { id, init } of statement.declaration?.type === 'VariableDeclaration' && statement.declaration.kind === 'const' ? statement.declaration.declarations : []) {
    const from = id.type === 'Identifier' && init?.type === 'Identifier' ? imports.get(init.name) : undefined

    if (from && id.type === 'Identifier')
      links.names.push({ exported: id.name, ...from })
  }
}
