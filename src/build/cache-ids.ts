import type * as t from '@babel/types'
import { parse } from '@babel/parser'
import { liveId } from './live-ids'

const MENTIONS_CACHE = /\bcache(?:Tag)?\b/
const NAMES_KAY_CACHE = /["']kay\/cache["']/
const SPACE = /\s/

// How many arguments each call is written with, so the id lands after them.
const ARGUMENTS: Record<string, number> = { cache: 2, cacheTag: 0 }

// Gives each `const name = cache(load, options)` and `const name = cacheTag()` at the top of a module the id it is known by, as a last argument, so a prerendered page's manifest, the server and every process sharing a store name the same key, whatever path or bundle runs the module.
export function cacheIds(source: string, file: string, root: string, jsx = false): string {
  if (!MENTIONS_CACHE.test(source) || !NAMES_KAY_CACHE.test(source))
    return source

  let ast: t.File

  try {
    ast = parse(source, { sourceType: 'module', attachComment: false, plugins: jsx ? ['typescript', 'jsx'] : ['typescript'] })
  }
  catch {
    return source
  }

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

  const comments = ast.comments ?? []
  const inserts: { at: number, text: string }[] = []

  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const')
      continue

    for (const { id, init } of declaration.declarations) {
      if (id.type !== 'Identifier' || init?.type !== 'CallExpression' || init.callee.type !== 'Identifier' || locals.get(init.callee.name) !== init.arguments.length)
        continue

      const text = JSON.stringify(`${id.name}.${liveId(file, root, id.name)}`)

      // After the last token of the last argument, parentheses and a trailing comma included, before any comment closing the call.
      let at = init.end! - 1

      for (let moved = true; moved;) {
        moved = false

        while (at > 0 && SPACE.test(source[at - 1]!))
          at--

        const comment = comments.find(found => found.end === at)

        if (comment) {
          at = comment.start!
          moved = true
        }
      }

      let separator = ''

      if (init.arguments.length > 0)
        separator = source[at - 1] === ',' ? ' ' : ', '

      inserts.push({ at, text: separator + text })
    }
  }

  let result = source

  for (const { at, text } of inserts.sort((a, b) => b.at - a.at))
    result = result.slice(0, at) + text + result.slice(at)

  return result
}
