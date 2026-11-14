import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { parseKay } from '../compiler/parser'
import { boundAt, proseSpans, templateScopes } from '../compiler/template-scopes'
import { importsOf, walk } from './ast'
import { bindings, boundOnce } from './bindings'
import { scan } from './renamed-exports'

type Kind = 'resource' | 'connection' | 'local' | 'track'

// The member each kind of source renamed, and what it is now: a plain rename, or the property of `sync` for a collection's sync state.
const MEMBERS: Record<Kind, Record<string, string>> = {
  resource: { value: 'data' },
  connection: { last: 'data' },
  local: { rows: 'data', unsynced: 'sync.queued', syncStatus: 'sync.status' },
  track: {},
}

// The hook each kind renamed to `onData`, and the field of its event that became `value`.
const HOOKS: Partial<Record<Kind, { from: string, field: string }>> = {
  local: { from: 'onSync', field: 'rows' },
  track: { from: 'onSuccess', field: 'data' },
}

const NEEDLE = /\.succeeded\b|\blocal\b|\bresource\b|\bstream\b|\bsocket\b|\.track\b/
const COMPARISONS = new Set(['===', '!==', '==', '!='])

const SUCCEEDED_DATA = 'an action\'s `succeeded()?.data` is `data()` since 1.105, as on every source; `succeeded()` works until 1.108'
const SUCCEEDED_STATE = 'an action\'s `succeeded() !== undefined`, or `succeeded` as a condition, is `status() === \'ready\'` since 1.105, as on every source; `succeeded()` works until 1.108'
const SUCCEEDED_OTHER = 'an action\'s `succeeded()` is `data()` and `status()` since 1.105, as on every source; `succeeded()` works until 1.108, and a read of this shape has no one-line fix: `succeeded()` held `{ data }` or undefined, `data()` holds the data itself'

const CONDITION_LINE = /^[ \t]*(?:else )?if $/
const LINE_END = /^[ \t]*(?:\r?\n|$)/

function escaped(name: string): string {
  return name.replaceAll('$', '\\$')
}

const KIND_NAMES: Record<Kind, string> = { resource: 'a `resource()`', connection: 'a `stream()` or `socket()`', local: 'a `local()` collection', track: 'a `track()` handle' }

function memberMessage(kind: Kind, from: string, to: string): string {
  return `${KIND_NAMES[kind]}'s \`${from}()\` is \`${to}()\` since 1.105, as on every source; the old name works until 1.108`
}

function hookMessage(kind: Kind, from: string): string {
  return `${kind === 'local' ? 'a `local()` collection' : 'a `track()` handle'}'s \`${from}\` is \`onData\` since 1.105, which hands its data as \`value\`, as on every source; the old name works until 1.108`
}

// A call `x.track(...)`, whatever `x` is: an action or `call`.
function isTrackCall(node: Node): boolean {
  return node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier' && node.callee.property.name === 'track'
}

// The edits for a hook handed to `onData`: its `field` read as `value`, undefined when the handler is no function written here whose first parameter is a pattern, or none.
function handlerEdits(handler: Node, field: string): Edit[] | undefined {
  if (handler.type !== 'ArrowFunctionExpression' && handler.type !== 'FunctionExpression')
    return undefined

  const [first] = handler.params

  if (first === undefined)
    return []

  if (first.type !== 'ObjectPattern')
    return undefined

  const edits: Edit[] = []

  for (const property of first.properties) {
    if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier' || property.key.name !== field)
      continue

    edits.push(property.shorthand ? { start: property.start, end: property.start, text: 'value: ' } : { start: property.key.start, end: property.key.end, text: 'value' })
  }

  return edits
}

// What kay's sources read since 1.105: `data()`, `onData`, and a collection's sync state under `sync`, in place of `value()`, `last()`, `rows()`, `unsynced()`, `syncStatus()`, `onSync`, `onSuccess` and an action's `succeeded()`.
// A source is known only by a name the file binds once to a call of `resource`, `stream`, `socket` or `local` from `kay`, or to a `.track()` call, as `kay check` reads no types; `succeeded()` is read on any receiver, no other kay value having one. A template reads the names its fences bind.
export async function sourceReaders(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-source-readers', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-source-readers', NEEDLE, ({ file, parsed, source, report }) => {
    const receivers = new Map<string, Kind>()
    const handled = new Set<number>()

    for (const { ast } of parsed) {
      const names = bindings(ast)

      for (const [kind, call] of [['resource', 'resource'], ['connection', 'stream'], ['connection', 'socket'], ['local', 'local']] as const) {
        for (const name of boundOnce(ast, names, call))
          receivers.set(name, kind)
      }

      walk(ast, (node) => {
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && isTrackCall(node.init) && names.get(node.id.name) === 1)
          receivers.set(node.id.name, 'track')
      })
    }

    for (const { ast, base, text } of parsed) {
      const local = importsOf(ast, from => from === 'kay', 'local')
      const spaceOf = (node: Node) => ({ start: base + node.start, end: base + node.end })

      // `onSuccess` of a handle or `onSync` of a collection, as a key of the options or a method.
      const hook = (kind: Kind, name: Node, handler: Node | undefined, shorthand: boolean) => {
        const spec = HOOKS[kind]!
        const rename: Edit = { start: base + name.start, end: base + name.end, text: 'onData' }
        const inner = shorthand || handler === undefined ? undefined : handlerEdits(handler, spec.field)

        report(base + name.start, base + name.end, hookMessage(kind, spec.from), 'write `onData`, its event\'s `value` for the field it renamed', inner === undefined ? null : [rename, ...inner.map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end }))])
      }

      const optionsOf = (call: Node, kind: Kind) => {
        if (call.type !== 'CallExpression')
          return

        const spec = HOOKS[kind]!

        for (const argument of call.arguments) {
          if (argument.type !== 'ObjectExpression')
            continue

          for (const property of argument.properties) {
            if (property.type === 'Property' && !property.computed && property.key.type === 'Identifier' && property.key.name === spec.from)
              hook(kind, property.key, property.value, property.shorthand)
          }
        }
      }

      walk(ast, (node) => {
        if (node.type === 'CallExpression') {
          const { callee } = node

          if (isTrackCall(node))
            optionsOf(node, 'track')
          else if (callee.type === 'Identifier' && local.locals.has(callee.name))
            optionsOf(node, 'local')

          if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier') {
            const kind = receivers.get(callee.object.name)
            const spec = kind === undefined ? undefined : HOOKS[kind]

            if (kind !== undefined && spec !== undefined && callee.property.name === spec.from)
              hook(kind, callee.property, node.arguments[0], false)

            if (callee.property.name === 'succeeded' && node.arguments.length === 0 && !handled.has(base + node.start))
              report(base + callee.property.start, base + callee.property.end, SUCCEEDED_OTHER, 'read `data()` or `status()`', null)
          }

          return
        }

        // `x.succeeded()?.data`, `x.succeeded()` as a condition and `x.succeeded() !== undefined`, the reads that have an exact rewrite.
        const ready = (call: Node, whole: Node, negated: boolean) => {
          const member = succeededMember(call)

          if (member === undefined)
            return false

          handled.add(base + call.start)
          report(base + member.property.start, base + member.property.end, SUCCEEDED_STATE, `write \`status() ${negated ? '!==' : '==='} 'ready'\``, [{ ...spaceOf(whole), text: `${text.slice(member.object.start, member.object.end)}.status() ${negated ? '!==' : '==='} 'ready'` }])

          return true
        }

        const data = node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'data' ? succeededMember(node.object) : undefined

        if (data !== undefined) {
          handled.add(base + data.object.start)
          report(base + data.property.start, base + node.end, SUCCEEDED_DATA, 'write `data()`', [{ start: base + data.property.start, end: base + node.end, text: 'data()' }])
        }
        else if (node.type === 'IfStatement' || node.type === 'ConditionalExpression' || node.type === 'WhileStatement') {
          ready(node.test, node.test, false)
        }
        else if (node.type === 'UnaryExpression' && node.operator === '!') {
          ready(node.argument, node, true)
        }
        else if (node.type === 'BinaryExpression' && COMPARISONS.has(node.operator)) {
          const [call, other] = node.left.type === 'CallExpression' ? [node.left, node.right] : [node.right, node.left]

          if (other.type === 'Identifier' && other.name === 'undefined')
            ready(call, node, node.operator.startsWith('='))
        }
        else if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.property.type === 'Identifier') {
          const kind = receivers.get(node.object.name)
          const to = kind === undefined ? undefined : MEMBERS[kind][node.property.name]

          if (kind !== undefined && to !== undefined)
            report(base + node.property.start, base + node.property.end, memberMessage(kind, node.property.name, to), `write \`${to}\``, [{ start: base + node.property.start, end: base + node.property.end, text: to }])
        }
      })
    }

    // The template, outside the fences: the same reads written as text.
    const fences = parsed.map(({ base, text }) => [base, base + text.length] as const)
    const template = file.endsWith('.kay') ? parseKay(source) : undefined
    const scopes = template ? templateScopes(template) : []
    const prose = template ? proseSpans(template) : []
    const outside = (index: number, name: string) => !fences.some(([from, to]) => index >= from && index < to) && !prose.some(span => index >= span.start && index < span.end) && !boundAt(scopes, name, index)

    for (const [name, kind] of receivers) {
      const names = Object.keys(MEMBERS[kind])

      if (names.length === 0)
        continue

      for (const match of source.matchAll(new RegExp(`(?<![\\w$.])${escaped(name)}\\.(${names.join('|')})\\b`, 'g'))) {
        if (!outside(match.index, name))
          continue

        const at = match.index + name.length + 1
        const to = MEMBERS[kind][match[1]!]!

        report(at, at + match[1]!.length, memberMessage(kind, match[1]!, to), `write \`${to}\``, [{ start: at, end: at + match[1]!.length, text: to }])
      }
    }

    if (!file.endsWith('.kay'))
      return

    for (const match of source.matchAll(/(?<![\w$.])([\w$]+)\.succeeded\(\)(\?\.data\b|\s*[!=]==?\s*undefined\b)?/g)) {
      const name = match[1]!

      if (!outside(match.index, name))
        continue

      const at = match.index + name.length + 1
      const tail = match[2]

      const line = source.slice(source.lastIndexOf('\n', match.index) + 1, match.index)

      // A template line that is the condition alone, `if x.succeeded()`.
      const condition = tail === undefined && CONDITION_LINE.test(line) && LINE_END.test(source.slice(match.index + match[0].length))

      if (condition)
        report(at, at + 'succeeded'.length, SUCCEEDED_STATE, 'write `status() === \'ready\'`', [{ start: match.index, end: match.index + match[0].length, text: `${name}.status() === 'ready'` }])
      else if (tail === undefined)
        report(at, at + 'succeeded'.length, SUCCEEDED_OTHER, 'read `data()` or `status()`', null)
      else if (tail.startsWith('?.'))
        report(at, at + match[0].length - name.length - 1, SUCCEEDED_DATA, 'write `data()`', [{ start: at, end: match.index + match[0].length, text: 'data()' }])
      else
        report(at, at + 'succeeded'.length, SUCCEEDED_STATE, 'write `status() === \'ready\'`', [{ start: match.index, end: match.index + match[0].length, text: `${name}.status() ${tail.includes('!') ? '===' : '!=='} 'ready'` }])
    }
  })
}

// The receiver and the method name of a call `x.succeeded()` with no arguments.
function succeededMember(node: Node): { object: Node, property: Node } | undefined {
  return node.type === 'CallExpression' && node.arguments.length === 0 && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier' && node.callee.property.name === 'succeeded' ? node.callee : undefined
}
