import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { importedName, walk } from './ast'
import { scan } from './renamed-exports'

const OLD_FRAME = /\.(?:send|publish)\([^)]*JSON\.stringify\(/
const HANDLERS = new Set(['open', 'message', 'close'])

// `ws.send(JSON.stringify(value))` in a handler of an `api()` module's `.ws()` route: every frame is JSON since 1.105, so the text sent here would reach the client as a string holding JSON.
// Found on the first parameter of an `open`, `message` or `close` handler written in the options of a `.ws()` chained from the `api` a file imports from `kay/server`.
export async function socketFrames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-socket-frames', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-socket-frames', OLD_FRAME, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      const apis = new Set<string>()

      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay/server')
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportSpecifier' && importedName(specifier) === 'api')
            apis.add(specifier.local.name)
        }
      }

      if (apis.size === 0)
        continue

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || !isWsOfApi(node, apis))
          return

        const hooks = node.arguments[1]

        if (hooks?.type !== 'ObjectExpression')
          return

        for (const property of hooks.properties) {
          if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier' || !HANDLERS.has(property.key.name))
            continue

          const handler = property.value

          if (handler.type !== 'FunctionExpression' && handler.type !== 'ArrowFunctionExpression')
            continue

          const [first] = handler.params

          if (first?.type !== 'Identifier')
            continue

          if (handler.body === null)
            continue

          walk(handler.body, (inner) => {
            const sent = framed(inner, first.name)

            if (sent)
              report(base + inner.start, base + inner.end, '`ws.send(JSON.stringify(value))` sends a string holding JSON since 1.105, as every frame is JSON; the old form works until 1.108', 'send the value itself', [{ start: base + sent.start, end: base + sent.end, text: text.slice(sent.argument.start, sent.argument.end) }])
          })
        }
      })
    }
  })
}

// A `.ws()` call whose callee chain starts at a call of `api`.
function isWsOfApi(node: Node & { type: 'CallExpression' }, apis: Set<string>): boolean {
  if (node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'ws')
    return false

  let current: Node = node.callee.object

  while (current.type === 'CallExpression') {
    if (current.callee.type === 'Identifier')
      return apis.has(current.callee.name)

    if (current.callee.type !== 'MemberExpression')
      return false

    current = current.callee.object
  }

  return false
}

// `<name>.send(JSON.stringify(argument))` or `<name>.publish(topic, JSON.stringify(argument))`, a compress flag allowed: the whole inner call and the argument.
function framed(node: Node, name: string): { start: number, end: number, argument: Node } | undefined {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.object.type !== 'Identifier' || node.callee.object.name !== name || node.callee.property.type !== 'Identifier' || (node.callee.property.name !== 'send' && node.callee.property.name !== 'publish'))
    return undefined

  const inner = node.arguments[node.callee.property.name === 'publish' ? 1 : 0]

  if (inner?.type !== 'CallExpression' || inner.callee.type !== 'MemberExpression' || inner.callee.object.type !== 'Identifier' || inner.callee.object.name !== 'JSON' || inner.callee.property.type !== 'Identifier' || inner.callee.property.name !== 'stringify' || inner.arguments.length !== 1 || inner.arguments[0]!.type === 'SpreadElement')
    return undefined

  return { start: inner.start, end: inner.end, argument: inner.arguments[0]! }
}
