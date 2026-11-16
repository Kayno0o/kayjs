import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import type { LintName } from '../compiler/lints'
import type { Edit, Found } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const FROM_KAY = (source: string) => source === 'kay' || source === 'kay/library' || source === '@kayjs/kay' || source === '@kayjs/kay/library'
const NEEDLE = /\b(?:deny|fail|refuse)\(/
const COMMENT = /\/[*/]/
const BEFORE_VALUE = /(?:\breturn|=>|[?:])\s*$/

type Call = NodeOfType<'CallExpression'>
type Part = [key: string, text: string]

const isText = (node: Node | undefined): boolean => node?.type === 'TemplateLiteral' || (node?.type === 'Literal' && typeof node.value === 'string')
const isUndefined = (node: Node | undefined): boolean => node?.type === 'Identifier' && node.name === 'undefined'

// `{ message: 'x', data }`, a part written as its key when the text is that name.
function objectOf(parts: Part[]): string {
  return `{ ${parts.map(([key, text]) => key === text ? key : `${key}: ${text}`).join(', ')} }`
}

// The edit swapping the arguments from `first` on for the object, or none when a comment sits between them, which the swap would drop.
function swapArguments(text: string, base: number, call: Call, first: number, parts: Part[]): Edit[] | null {
  const from = call.arguments[first]!
  const to = call.arguments.at(-1)!

  if (COMMENT.test(text.slice(from.start, to.end)))
    return null

  return [{ start: base + from.start, end: base + to.end, text: objectOf(parts) }]
}

// `ctx.deny(status, 'message', data)`, `ctx.deny(status, { message, data })` since 1.105: a refusal takes the one `{ message, errors, data }` everywhere, as `refuse(status, options)` does.
// Found on a call of `deny`, bare or read off a name, whose status is a literal from 400 to 599 and whose second argument is a text.
function denyCalls({ parsed, report }: Found): void {
  for (const { ast, base, text } of parsed) {
    walk(ast, (node) => {
      if (node.type !== 'CallExpression' || !isDeny(node.callee) || node.arguments.length < 2 || node.arguments.length > 3 || !isErrorStatus(node.arguments[0]) || !isText(node.arguments[1]) || node.arguments.some(argument => argument.type === 'SpreadElement'))
        return

      const [, message, data] = node.arguments as [Node, Node, Node | undefined]
      const parts: Part[] = [['message', text.slice(message.start, message.end)]]

      if (data !== undefined && !isUndefined(data))
        parts.push(['data', text.slice(data.start, data.end)])

      report(base + node.start, base + node.end, '`deny(status, message, data)` is `deny(status, { message, data })` since 1.105', 'write the message and the data in one object', swapArguments(text, base, node, 1, parts))
    })
  }
}

function isDeny(callee: Node): boolean {
  return (callee.type === 'Identifier' && callee.name === 'deny') || (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'deny')
}

function isErrorStatus(node: Node | undefined): boolean {
  return node?.type === 'Literal' && typeof node.value === 'number' && node.value >= 400 && node.value <= 599
}

// `return ctx.fail(status, data, errors)`, `return ctx.deny(status, { data, errors })` since 1.105: an action refuses as a guard and a page do. A text is the message.
// Found on `ctx.fail` of a handler's `ctx`; the fix is made where the call is returned, as `deny` throws and `fail` did not.
function failCalls({ parsed, report }: Found): void {
  for (const { ast, base, text } of parsed) {
    walk(ast, (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.object.type !== 'Identifier' || node.callee.object.name !== 'ctx' || node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'fail' || node.arguments.length === 0)
        return

      const [status, data, errors] = node.arguments
      const parts: Part[] = []

      if (data !== undefined && !isUndefined(data))
        parts.push([isText(data) ? 'message' : 'data', text.slice(data.start, data.end)])

      if (errors !== undefined && !isUndefined(errors))
        parts.push(['errors', text.slice(errors.start, errors.end)])

      const returned = BEFORE_VALUE.test(text.slice(0, node.start))
      const plain = node.arguments.length <= 3 && node.arguments.every(argument => argument.type !== 'SpreadElement') && status !== undefined && !COMMENT.test(text.slice(status.start, node.end))
      const property = node.callee.property
      const edits: Edit[] = [{ start: base + property.start, end: base + property.end, text: 'deny' }]

      if (parts.length > 0)
        edits.push({ start: base + status!.end, end: base + node.end - 1, text: `, ${objectOf(parts)}` })

      report(base + node.start, base + node.end, '`ctx.fail(status, data, errors)` is `ctx.deny(status, { data, errors })` since 1.105', 'write `ctx.deny` with the data and the errors in one object', returned && plain ? edits : null)
    })
  }
}

// `refuse('message', { status, errors, data })`, `refuse(status, { message, errors, data })` since 1.105.
// Found on a call of `refuse` imported from `kay`, whose first argument is a text; the fix is made when the options are an object written in the call and the status is known.
function refuseCalls({ parsed, report }: Found): void {
  for (const { ast, base, text } of parsed) {
    const { locals, namespaces } = importsOf(ast, FROM_KAY, 'refuse')

    if (locals.size === 0 && namespaces.size === 0)
      continue

    walk(ast, (node) => {
      const named = node.type === 'CallExpression' && (node.callee.type === 'Identifier' ? locals.has(node.callee.name) : node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && namespaces.has(node.callee.object.name) && node.callee.property.type === 'Identifier' && node.callee.property.name === 'refuse')

      if (!named || node.type !== 'CallExpression' || !isText(node.arguments[0]) || node.arguments.length > 2)
        return

      report(base + node.start, base + node.end, '`refuse(message, { status, errors, data })` is `refuse(status, { message, errors, data })` since 1.105', 'write the status first and the message in the options', refuseEdits(text, base, node))
    })
  }
}

function fieldsOf(errors: Node): 'none' | 'named' | 'unknown' {
  if (errors.type !== 'ObjectExpression')
    return 'unknown'

  return errors.properties.length > 0 ? 'named' : 'none'
}

function refuseEdits(text: string, base: number, call: Call): Edit[] | null {
  const [message, options] = call.arguments as [Node, Node | undefined]
  const parts: Part[] = [['message', text.slice(message.start, message.end)]]
  let status: string | undefined
  // Without a status, `errors` naming fields is a 422, which only an object written in the call can be told to name some.
  let fields: 'none' | 'named' | 'unknown' = 'none'

  if (options !== undefined) {
    if (options.type !== 'ObjectExpression' || COMMENT.test(text.slice(options.start, options.end)))
      return null

    for (const property of options.properties) {
      if (property.type !== 'Property' || property.computed || property.kind !== 'init' || property.method || property.key.type !== 'Identifier')
        return null

      const { name } = property.key
      const value = text.slice(property.value.start, property.value.end)

      if (name === 'status') {
        status = value
      }
      else if (name === 'data') {
        parts.push([name, value])
      }
      else if (name === 'errors') {
        parts.push([name, value])
        fields = fieldsOf(property.value)
      }
      else {
        return null
      }
    }
  }

  if (status === undefined && fields === 'unknown')
    return null

  return [{ start: base + message.start, end: base + (options ?? message).end, text: `${status ?? (fields === 'named' ? '422' : '403')}, ${objectOf(parts)}` }]
}

const SCANS: [LintName, (found: Found) => void][] = [
  ['deprecated-deny-call', denyCalls],
  ['deprecated-ctx-fail', failCalls],
  ['deprecated-refuse-call', refuseCalls],
]

// The three spellings of a refusal before 1.105, found in the TypeScript files and `.kay` files of the project as `kay check` reads no types: a call through a name it cannot follow is not found.
export async function refusalCalls(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const found = await Promise.all(SCANS.filter(([lint]) => lintLevel(lint, options.lints) !== 'allow').map(async ([lint, visit]) => scan(root, options, lint, NEEDLE, visit)))

  return found.flat()
}
