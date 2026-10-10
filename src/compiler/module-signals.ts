import type * as t from '@babel/types'
import { parse } from '@babel/parser'

// A signal is written by assigning its name; a memo is only read.
export type SignalKind = 'signal' | 'memo'

// The signals and memos of each module a component imports, by the specifier it imports them with.
export type ImportedSignals = Record<string, Record<string, SignalKind>>

const MADE: Record<string, SignalKind> = { signal: 'signal', persisted: 'signal', linked: 'signal', queryParam: 'signal', memo: 'memo' }
const NAMES_KAY = /["']kay["']/

// The names a module exports as `export const name = signal(...)`, or `persisted`, `linked`, `queryParam` or `memo`, called as imported from `kay`: what a template importing them reads by name.
export function moduleSignals(source: string, jsx = false): Record<string, SignalKind> {
  if (!NAMES_KAY.test(source))
    return {}

  let ast: t.File

  try {
    ast = parse(source, { sourceType: 'module', plugins: jsx ? ['typescript', 'jsx'] : ['typescript'] })
  }
  catch {
    return {}
  }

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
