import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const KAY = /^kay(?:\/|$)/
const NEEDLE = /\baction\s*\(/
const TRAILING_COMMA = /,$/
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression'])

// `action(schema, handler, options)` and `action(handler, options)` as kay 1.107 replaces them: the options come first, with the input in them, as an API route's do: `action({ input: schema, ...options }, handler)`.
// Found on the `action` a file imports from `kay`, in the TypeScript files and the fences of `.kay` files; the fix moves the arguments and keeps their text.
export async function actionOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-action-options', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-action-options', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      const locals = importsOf(ast, source => KAY.test(source), 'action').locals

      if (locals.size === 0)
        continue

      const slice = (node: Node): string => text.slice(node.start, node.end)

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !locals.has(node.callee.name))
          return

        const [first, second, third] = node.arguments

        if (first === undefined || second === undefined || node.arguments.length > 3 || node.arguments.some(argument => argument.type === 'SpreadElement'))
          return

        // `action(handler, options)`
        if (FUNCTIONS.has(first.type)) {
          if (third !== undefined || FUNCTIONS.has(second.type))
            return

          report(base + node.start, base + node.end, 'an action takes its options before the handler since 1.107, as an API route does, `action(options, handler)`; the old order works until 2.0', 'write the options first', [{ start: base + first.start, end: base + second.end, text: `${slice(second)}, ${slice(first)}` }])

          return
        }

        // `action(schema, handler, options)`
        if (third === undefined)
          return

        const inner = third.type === 'ObjectExpression' ? text.slice(third.start + 1, third.end - 1).trim().replace(TRAILING_COMMA, '') : `...${slice(third)}`

        report(base + node.start, base + node.end, 'an action takes its input and its options in one object before the handler since 1.107, `action({ input, ...options }, handler)`; the old form works until 2.0', 'write the input and the options first', [{ start: base + first.start, end: base + third.end, text: `{ input: ${slice(first)}${inner === '' ? '' : `, ${inner}`} }, ${slice(second)}` }])
      })
    }
  })
}
