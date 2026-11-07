import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { walk } from './ast'
import { scan } from './renamed-exports'
import { bindings, boundOnce } from './stream-on'

const LOCAL = /\blocal\b/
const COMPARISONS = new Set(['===', '!==', '==', '!='])
const PENDING = 'a `local()` collection\'s `pending()` is `unsynced()` since 1.92: it counts the writes the server has not taken, and `pending()` is a boolean at 2.0, as on every source; the old name works until then'
const STATUS = 'a `local()` collection\'s `status()` is `syncStatus()` since 1.92, which reads `unsynced` for `pending`; `status()` is `idle|loading|ready|failed` at 2.0, as on every source, and the old name works until then'
const HELP_PENDING = 'write `unsynced()`'
const HELP_STATUS = 'write `syncStatus()`, comparing with \'unsynced\' for \'pending\''

function escaped(name: string): string {
  return name.replaceAll('$', '\\$')
}

// `.pending()` and `.status()` of a collection `local()` made, `.unsynced()` and `.syncStatus()` since 1.92.
// Only a name the file binds once to a call of `local` from `kay` is known to be a collection, as `kay check` reads no types; the template of a `.kay` file reads the names its fences bind. A `status()` compared with a string (`===`, `!==`, `==`, `!=`, a `switch`) is renamed with its `'pending'` becoming `'unsynced'`; one read in any other way is reported with no fix, as the word it holds changed.
export async function localState(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-local-state', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-local-state', LOCAL, ({ parsed, source, report }) => {
    const receivers = new Set<string>()

    for (const { ast } of parsed) {
      for (const name of boundOnce(ast, bindings(ast), 'local'))
        receivers.add(name)
    }

    if (receivers.size === 0)
      return

    const statusCall = (node: Node): { name: string, property: Node } | undefined => {
      if (node.type !== 'CallExpression' || node.optional || node.arguments.length > 0 || node.callee.type !== 'MemberExpression' || node.callee.computed)
        return undefined

      const { object, property } = node.callee

      return object.type === 'Identifier' && receivers.has(object.name) && property.type === 'Identifier' && property.name === 'status' ? { name: object.name, property } : undefined
    }

    // The statuses a comparison or a switch fixes, by the offset of their `status` name.
    const handled = new Set<number>()

    for (const { ast, base, text } of parsed) {
      const retell = (literal: Node): Edit[] => {
        if (literal.type !== 'Literal' || literal.value !== 'pending')
          return []

        const quote = text[literal.start]!

        return [{ start: base + literal.start, end: base + literal.end, text: `${quote}unsynced${quote}` }]
      }

      walk(ast, (node) => {
        if (node.type === 'BinaryExpression' && COMPARISONS.has(node.operator)) {
          const [call, other] = statusCall(node.left) ? [node.left, node.right] : [node.right, node.left]
          const found = statusCall(call)

          if (found && other.type === 'Literal' && typeof other.value === 'string') {
            handled.add(base + found.property.start)
            report(base + found.property.start, base + found.property.end, STATUS, HELP_STATUS, [{ start: base + found.property.start, end: base + found.property.end, text: 'syncStatus' }, ...retell(other)])
          }
        }
        else if (node.type === 'SwitchStatement') {
          const found = statusCall(node.discriminant)

          if (found && node.cases.every(each => each.test === null || each.test.type === 'Literal')) {
            handled.add(base + found.property.start)
            report(base + found.property.start, base + found.property.end, STATUS, HELP_STATUS, [{ start: base + found.property.start, end: base + found.property.end, text: 'syncStatus' }, ...node.cases.flatMap(each => each.test === null ? [] : retell(each.test))])
          }
        }
      })

      walk(ast, (node) => {
        if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier' || !receivers.has(node.object.name) || node.property.type !== 'Identifier')
          return

        const { property } = node
        const at = base + property.start

        if (property.name === 'pending')
          report(at, base + property.end, PENDING, HELP_PENDING, [{ start: at, end: base + property.end, text: 'unsynced' }])
        else if (property.name === 'status' && !handled.has(at))
          report(at, base + property.end, STATUS, HELP_STATUS, null)
      })
    }

    // The template, outside the fences: the same reads written as text.
    const fences = parsed.map(({ base, text }) => [base, base + text.length] as const)
    const outside = (index: number) => !fences.some(([from, to]) => index >= from && index < to)

    for (const name of receivers) {
      const own = escaped(name)
      const head = `(?<![\\w$.])${own}\\.`
      const compared = new Set<number>()

      for (const match of source.matchAll(new RegExp(`${head}(status)\\(\\)\\s*(?:[!=]==?)\\s*(['"])([\\w-]+)\\2`, 'g'))) {
        if (!outside(match.index))
          continue

        const at = match.index + name.length + 1
        const literal = match.index + match[0].lastIndexOf(match[3]!)

        compared.add(at)
        report(at, at + 'status'.length, STATUS, HELP_STATUS, [{ start: at, end: at + 'status'.length, text: 'syncStatus' }, ...match[3] === 'pending' ? [{ start: literal, end: literal + 'pending'.length, text: 'unsynced' }] : []])
      }

      for (const match of source.matchAll(new RegExp(`${head}(pending|status)\\b`, 'g'))) {
        const at = match.index + name.length + 1

        if (!outside(match.index) || compared.has(at))
          continue

        if (match[1] === 'pending')
          report(at, at + 'pending'.length, PENDING, HELP_PENDING, [{ start: at, end: at + 'pending'.length, text: 'unsynced' }])
        else
          report(at, at + 'status'.length, STATUS, HELP_STATUS, null)
      }
    }
  })
}
