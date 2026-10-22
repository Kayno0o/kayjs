import type { Insert } from './insert-ids'
import { relative } from 'node:path'
import { applyInserts, argumentsEnd, parseModule } from './insert-ids'

const MENTIONS_LIVE = /\blive\b/
const NAMES_KAY = /["']kay["']/
const ID_LENGTH = 12

// The name the server and the browser know a live value by: a short hash of its module's path from the project and its constant, so no file path reaches a page.
export function liveId(file: string, root: string, name: string): string {
  return new Bun.CryptoHasher('sha256').update(`${relative(root, file).split('\\').join('/')}#${name}`).digest('base64url').slice(0, ID_LENGTH)
}

// Gives each `const name = live(...)` at the top of a module the id it is known by, as a second argument, so the server and the browser, which each load the module, name the same value.
// With `names`, the constant's name follows as a third, which the server prints in its errors and a browser has no use for.
export function liveIds(source: string, file: string, root: string, jsx = false, names = false): string {
  if (!MENTIONS_LIVE.test(source) || !NAMES_KAY.test(source))
    return source

  const ast = parseModule(source, jsx)

  if (!ast)
    return source

  const locals = new Set<string>()

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay' || statement.importKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'live')
        locals.add(specifier.local.name)
    }
  }

  if (locals.size === 0)
    return source

  const inserts: Insert[] = []

  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const')
      continue

    for (const { id, init } of declaration.declarations) {
      if (id.type !== 'Identifier' || init?.type !== 'CallExpression' || init.callee.type !== 'Identifier' || !locals.has(init.callee.name) || init.arguments.length !== 1)
        continue

      const at = argumentsEnd(source, ast, init)
      const text = names ? `${JSON.stringify(liveId(file, root, id.name))}, ${JSON.stringify(id.name)}` : JSON.stringify(liveId(file, root, id.name))

      inserts.push(source[at - 1] === ',' ? { at, text: ` ${text}` } : { at, text: `, ${text}` })
    }
  }

  return applyInserts(source, inserts)
}
