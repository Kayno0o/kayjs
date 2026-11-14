import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, Program } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const NEEDLE = /\.enforce\b/
const FROM_SERVER = (source: string) => source === 'kay/server'
const HELP = 'write `check`, which refuses with a 429 as `enforce` did'

// `limit.enforce(ctx)` on what `rateLimit()` returns, `limit.check(ctx)` since 1.105: `limiter().enforce(key)` counts under a key and refuses nothing, so the one name kept two meanings.
// Found in the TypeScript files and `.kay` files of the project, on a name bound once to a call of `rateLimit` imported from `kay/server`, as `kay check` reads no types; the fix renames the method.
export async function rateEnforce(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-rate-enforce', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-rate-enforce', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const { locals, namespaces } = importsOf(ast, FROM_SERVER, 'rateLimit')

      if (locals.size === 0 && namespaces.size === 0)
        continue

      const limits = limitNames(ast, locals, namespaces)

      walk(ast, (node) => {
        if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier' || node.property.type !== 'Identifier' || node.property.name !== 'enforce' || !limits.has(node.object.name))
          return

        report(base + node.property.start, base + node.property.end, '`enforce` of a `rateLimit()` limit is `check` since 1.105', HELP, [{ start: base + node.property.start, end: base + node.property.end, text: 'check' }])
      })
    }
  })
}

// The names a file binds once to `rateLimit(...)`, or `server.rateLimit(...)` of a namespace import.
function limitNames(ast: Program, locals: Set<string>, namespaces: Set<string>): Set<string> {
  const bound = new Map<string, number>()
  const limits = new Set<string>()
  const isLimit = (init: Node): boolean => init.type === 'CallExpression' && ((init.callee.type === 'Identifier' && locals.has(init.callee.name)) || (init.callee.type === 'MemberExpression' && !init.callee.computed && init.callee.object.type === 'Identifier' && namespaces.has(init.callee.object.name) && init.callee.property.type === 'Identifier' && init.callee.property.name === 'rateLimit'))

  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier')
      return

    bound.set(node.id.name, (bound.get(node.id.name) ?? 0) + 1)

    if (node.init && isLimit(node.init))
      limits.add(node.id.name)
  })

  return new Set([...limits].filter(name => bound.get(name) === 1))
}
