import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, Program } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { unwrapped } from '../compiler/object-literal'
import { importedName, importsOf, walk } from './ast'
import { bindings, boundOnce } from './bindings'
import { scan } from './renamed-exports'

type Kind = 'plain' | 'key' | 'user' | 'unknown'

const LIVE_CALL = /\blive\s*[(<]/
const PROJECT_SOURCE = /^(?:[./#~]|@\/)/
const SPECIAL = /[$.*+?^{}()|[\]\\]/g

// What a declaration `live(initial, options)` is: a value per key given a function of it or `key: true`, per user given `user: true`, and unknown when the options are no object written there.
function kindOf(call: Node): Kind {
  if (call.type !== 'CallExpression')
    return 'unknown'

  const [initial, options] = call.arguments

  if (options !== undefined && options.type !== 'ObjectExpression')
    return 'unknown'

  const flag = (name: string) => options?.type === 'ObjectExpression' && options.properties.some(property => property.type === 'Property' && !property.computed && property.key.type === 'Identifier' && property.key.name === name && property.value.type === 'Literal' && property.value.value === true)

  if (flag('user'))
    return 'user'

  return flag('key') || initial?.type === 'ArrowFunctionExpression' || initial?.type === 'FunctionExpression' ? 'key' : 'plain'
}

// The live values a program declares, by the name they are bound to once.
function declared(ast: Program): Map<string, Kind> {
  const names = bindings(ast)
  const known = boundOnce(ast, names, 'live')
  const kinds = new Map<string, Kind>()

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && known.has(node.id.name))
      kinds.set(node.id.name, kindOf(unwrapped(node.init)))
  })

  return kinds
}

// The text of an argument as the property of an options object: `{ key }` for an identifier of that name.
function property(name: string, argument: Node, text: string): string {
  return argument.type === 'Identifier' && argument.name === name ? name : `${name}: ${text.slice(argument.start, argument.end)}`
}

// Whether the second argument of a `set` is the options of the new form, an object holding only `field`.
function isOptions(argument: Node, field: string): boolean {
  return argument.type === 'ObjectExpression' && argument.properties.length === 1 && argument.properties[0]!.type === 'Property' && !argument.properties[0]!.computed && argument.properties[0]!.key.type === 'Identifier' && argument.properties[0]!.key.name === field
}

// What live values and `presence` take since 1.105: `set(next, { key })` and `set(next, { user })` in place of `set(key, next)`, and `presence({ room, member })` in place of `presence(room, member)`.
// A value is known by a name the file binds once to a `live()` call from `kay`, or imports under the name of a declaration of the project that every file agrees on, as `kay check` reads no types; `presence` is the one imported from `kay`.
export async function liveApi(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-live-api', options.lints) === 'allow')
    return []

  // The kinds each declared name is given across the project, so an import of it is known.
  const everywhere = new Map<string, Set<Kind>>()

  await scan(root, options, 'deprecated-live-api', LIVE_CALL, ({ parsed }) => {
    for (const { ast } of parsed) {
      for (const [name, kind] of declared(ast))
        (everywhere.get(name) ?? everywhere.set(name, new Set()).get(name)!).add(kind)
    }
  })

  // A file is read when it names a live value declared in the project, whatever else it holds, as `live` is written where it is declared.
  const named = [...everywhere.keys()].map(name => name.replace(SPECIAL, String.raw`\$&`))
  const needle = new RegExp(`\\b(?:live|presence${named.map(name => `|${name}`).join('')})\\b`)

  return scan(root, options, 'deprecated-live-api', needle, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      const receivers = declared(ast)
      const names = bindings(ast)

      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || !PROJECT_SOURCE.test(statement.source.value))
          continue

        for (const specifier of statement.specifiers) {
          const kinds = specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' ? everywhere.get(importedName(specifier)) : undefined

          if (kinds?.size === 1 && names.get(specifier.local.name) === 1)
            receivers.set(specifier.local.name, [...kinds][0]!)
        }
      }

      const presences = importsOf(ast, from => from === 'kay', 'presence').locals

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.arguments.some(argument => argument.type === 'SpreadElement'))
          return

        const { callee, arguments: args } = node

        if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && callee.property.name === 'set' && args.length === 2) {
          const kind = receivers.get(callee.object.name)

          if ((kind !== 'key' && kind !== 'user') || isOptions(args[1]!, kind))
            return

          const [first, second] = args as [Node, Node]

          report(base + callee.property.start, base + callee.property.end, `\`${callee.object.name}.set(${kind}, next)\` of a live value per ${kind} is \`set(next, { ${kind} })\` since 1.105, as one \`set\` writes every live value; the old order works until 1.108`, `write \`set(next, { ${kind} })\``, first.type === 'SequenceExpression' || second.type === 'SequenceExpression' ? null : [{ start: base + first.start, end: base + second.end, text: `${text.slice(second.start, second.end)}, { ${property(kind, first, text)} }` }])

          return
        }

        if (callee.type !== 'Identifier' || !presences.has(callee.name) || args.length === 0 || args[0]!.type === 'ObjectExpression')
          return

        const [room, member, extra] = args as [Node, Node | undefined, Node | undefined]
        const parts = [property('room', room, text), ...member ? [property('member', member, text)] : []]
        let fix: Edit[] | null = null

        // A lone argument that is no string was the options of the old form, as `presence(options)`.
        const written = args.length > 1 || room.type === 'Literal' || room.type === 'TemplateLiteral'

        if (written && !args.some(argument => argument.type === 'SequenceExpression') && (extra === undefined || extra.type === 'ObjectExpression')) {
          if (extra !== undefined && extra.properties.length > 0)
            parts.push(text.slice(extra.properties[0]!.start, extra.properties.at(-1)!.end))

          fix = [{ start: base + room.start, end: base + (extra ?? member ?? room).end, text: `{ ${parts.join(', ')} }` }]
        }

        report(base + callee.start, base + callee.end, '`presence(room, member)` is `presence({ room, member })` since 1.105, as every kay call with options takes one object; the old form works until 1.108', 'write `presence({ room, member })`', fix)
      })
    }
  })
}
