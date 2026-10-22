import type { Insert } from './insert-ids'
import { applyInserts, argumentsEnd, parseModule } from './insert-ids'
import { liveId } from './live-ids'

const MENTIONS_CACHE = /\bcache(?:Tag)?\b/
const NAMES_KAY_CACHE = /["']kay\/cache["']/

// How many arguments each call is written with, so the id lands after them.
const ARGUMENTS: Record<string, number> = { cache: 2, cacheTag: 0 }

// Gives each `const name = cache(load, options)` and `const name = cacheTag()` at the top of a module the id it is known by, as a last argument, so a prerendered page's manifest, the server and every process sharing a store name the same key, whatever path or bundle runs the module.
export function cacheIds(source: string, file: string, root: string, jsx = false): string {
  if (!MENTIONS_CACHE.test(source) || !NAMES_KAY_CACHE.test(source))
    return source

  const ast = parseModule(source, jsx)

  if (!ast)
    return source

  const locals = new Map<string, number>()

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay/cache' || statement.importKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type')
        continue

      const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value

      if (imported in ARGUMENTS)
        locals.set(specifier.local.name, ARGUMENTS[imported]!)
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
      if (id.type !== 'Identifier' || init?.type !== 'CallExpression' || init.callee.type !== 'Identifier' || locals.get(init.callee.name) !== init.arguments.length)
        continue

      const text = JSON.stringify(`${id.name}.${liveId(file, root, id.name)}`)

      const at = argumentsEnd(source, ast, init)
      let separator = ''

      if (init.arguments.length > 0)
        separator = source[at - 1] === ',' ? ' ' : ', '

      inserts.push({ at, text: separator + text })
    }
  }

  return applyInserts(source, inserts)
}
