import type { Node, Program } from './estree'
import { parseProgram } from './estree'

// A signal is written by assigning its name; a memo is only read; a live value is only read in the browser, the server changing it.
export type SignalKind = 'signal' | 'memo' | 'live'

// The signals and memos of each module a component imports, by the specifier it imports them with.
export type ImportedSignals = Record<string, Record<string, SignalKind>>

export const MADE: Record<string, SignalKind> = { signal: 'signal', persisted: 'signal', linked: 'signal', queryParam: 'signal', memo: 'memo', debounced: 'memo', live: 'live' }
const NAMES_KAY = /["']kay["']/

// The names a module exports as `export const name = signal(...)`, or `persisted`, `linked`, `queryParam`, `memo`, `debounced` or `live`, called as imported from `kay`: what a component importing them writes by assigning, and reads by calling.
export function moduleSignals(source: string, jsx = false): Record<string, SignalKind> {
  const ast = NAMES_KAY.test(source) ? parseModule(source, jsx) : undefined

  return ast ? signalsIn(ast) : {}
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

function signalsIn(ast: Program): Record<string, SignalKind> {
  const made = new Map<string, SignalKind>()
  const found: Record<string, SignalKind> = {}

  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay' || statement.importKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      const imported = specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' ? specifier.imported : undefined
      const kind = imported && MADE[imported.type === 'Identifier' ? imported.name : imported.value]

      if (kind)
        made.set(specifier.local.name, kind)
    }
  }

  for (const statement of ast.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : undefined

    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const')
      continue

    for (const { id, init } of declaration.declarations) {
      const kind = id.type === 'Identifier' && init?.type === 'CallExpression' && init.callee.type === 'Identifier' ? made.get(init.callee.name) : undefined

      if (id.type === 'Identifier' && kind)
        found[id.name] = kind
    }
  }

  return found
}
