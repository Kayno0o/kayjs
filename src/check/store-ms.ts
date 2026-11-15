import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { importsOf, walk } from './ast'
import { evaluate, EXPRESSION } from './format-duration'
import { scan } from './renamed-exports'

const NEEDLE = /\bkv\b/
const FROM_SERVER = (source: string) => source === 'kay/server' || source === '@kayjs/kay/server'
const FROM_LIBRARY = (source: string) => source === 'kay/library' || source === '@kayjs/kay/library'
// The methods of a `Kv` that take a ttl, with its position.
const TTL_AT: Record<string, number> = { set: 2, once: 1 }

// A ttl of `kv(namespace).set(key, value, ms)` or `.once(key, ms)` written as milliseconds, a `Duration` since 1.105: `once(key, 60_000)` is `once(key, '60000ms')`.
// Found on a call chained to `kv(...)` or on a name bound once to it in the same file, with a number written as a literal or arithmetic of literals; one held in a variable is a type error in the editor.
export async function storeMs(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-store-ms', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-store-ms', NEEDLE, ({ source, parsed, report }) => {
    for (const { ast, base } of parsed) {
      const makers = new Set([...importsOf(ast, FROM_SERVER, 'kv').locals, ...importsOf(ast, FROM_LIBRARY, 'kv').locals])

      if (makers.size === 0)
        continue

      const isKv = (node: Node): boolean => node.type === 'CallExpression' && node.callee.type === 'Identifier' && makers.has(node.callee.name)
      const declared = new Map<string, number>()
      const kvs = new Set<string>()

      walk(ast, (node: Node) => {
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier')
          return

        declared.set(node.id.name, (declared.get(node.id.name) ?? 0) + 1)

        if (node.init !== null && node.init !== undefined && isKv(node.init))
          kvs.add(node.id.name)
      })

      // A name declared once in the file, so a shadowing local of the same name never takes a call that is not kv's.
      const bound = new Set([...kvs].filter(name => declared.get(name) === 1))

      walk(ast, (node: Node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.type !== 'Identifier')
          return

        const at = TTL_AT[node.callee.property.name]
        const { object } = node.callee

        if (at === undefined || !(isKv(object) || (object.type === 'Identifier' && bound.has(object.name))))
          return

        const argument = node.arguments[at]

        if (argument === undefined)
          return

        const start = base + argument.start
        const end = base + argument.end
        const text = source.slice(start, end)

        if (!EXPRESSION.test(text))
          return

        const milliseconds = evaluate(text)

        report(start, end, 'a `kv` ttl takes a duration with its unit since 1.105, not milliseconds', 'write the length with its unit, `kv(\'ns\').once(key, \'60000ms\')`', Number.isFinite(milliseconds) ? [{ start, end, text: `'${milliseconds}ms'` }] : null)
      })
    }
  })
}
