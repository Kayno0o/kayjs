import type * as t from '@babel/types'
import { relative } from 'node:path'
import { parse } from '@babel/parser'

const MENTIONS_LIVE = /\blive\b/
const NAMES_KAY = /["']kay["']/

// The name the server and the browser know a live value by: its module's path from the project and its constant, `src/live.ts#visitors`.
export function liveId(file: string, root: string, name: string): string {
  return `${relative(root, file).split('\\').join('/')}#${name}`
}

// Gives each `const name = live(...)` at the top of a module the id it is known by, as a second argument, so the server and the browser, which each load the module, name the same value.
export function liveIds(source: string, file: string, root: string, jsx = false): string {
  if (!MENTIONS_LIVE.test(source) || !NAMES_KAY.test(source))
    return source

  let ast: t.File

  try {
    ast = parse(source, { sourceType: 'module', attachComment: false, plugins: jsx ? ['typescript', 'jsx'] : ['typescript'] })
  }
  catch {
    return source
  }

  const names = new Set<string>()

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay' || statement.importKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'live')
        names.add(specifier.local.name)
    }
  }

  if (names.size === 0)
    return source

  const inserts: { at: number, text: string }[] = []

  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const')
      continue

    for (const { id, init } of declaration.declarations) {
      if (id.type !== 'Identifier' || init?.type !== 'CallExpression' || init.callee.type !== 'Identifier' || !names.has(init.callee.name) || init.arguments.length !== 1)
        continue

      const last = init.arguments[0]!
      const comma = source.slice(last.end!, init.end! - 1).indexOf(',')
      const text = JSON.stringify(liveId(file, root, id.name))

      inserts.push(comma === -1 ? { at: last.end!, text: `, ${text}` } : { at: last.end! + comma + 1, text: ` ${text}` })
    }
  }

  let result = source

  for (const { at, text } of inserts.sort((a, b) => b.at - a.at))
    result = result.slice(0, at) + text + result.slice(at)

  return result
}
