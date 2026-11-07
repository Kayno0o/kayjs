import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, Program } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { renamedTypes, scan } from './renamed-exports'

const SINCE = '1.92'
const UNTIL = '1.95'
const ON = /\bon\b/
const ON_OPEN = /\bonOpen\b/
const VALUE = /\bvalue\b/

// The types of `kay` renamed when `stream()` came down to one return type and a connection base.
export const STREAM_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = { kay: { EventReader: 'Connection', StreamRun: 'Stream' } }

const OLD_STREAM_TYPE = /\b(?:EventReader|StreamRun)\b/

// `EventReader` and `StreamRun` imported from `kay`: the fix renames the import and every use of it.
export async function streamTypes(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return renamedTypes(root, options, { lint: 'deprecated-stream-types', modules: STREAM_TYPES, needle: OLD_STREAM_TYPE, since: SINCE, until: UNTIL })
}

function annotated(param: Node): boolean {
  const { typeAnnotation } = param as { typeAnnotation?: Node | null }

  return typeAnnotation !== undefined && typeAnnotation !== null
}

// Every name the program binds, counted, so one bound twice is not taken for either.
function bindings(program: Program): Map<string, number> {
  const counts = new Map<string, number>()
  const add = (pattern: Node | null | undefined) => {
    if (!pattern)
      return

    walk(pattern, (node) => {
      if (node.type === 'Identifier')
        counts.set(node.name, (counts.get(node.name) ?? 0) + 1)
    })
  }

  walk(program, (node) => {
    if (node.type === 'VariableDeclarator') {
      add(node.id)
    }
    else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      if (node.type !== 'ArrowFunctionExpression')
        add(node.id)

      for (const param of node.params)
        add(param)
    }
    else if (node.type === 'AssignmentExpression') {
      add(node.left)
    }
    else if (node.type === 'CatchClause') {
      add(node.param)
    }
    else if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers)
        add(specifier.local)
    }
    else if (node.type === 'ClassDeclaration') {
      add(node.id)
    }
  })

  return counts
}

// The names the file binds once to a call of `stream` or `socket` from `kay`, the only receivers known to be one as `kay check` reads no types.
function sourceReceivers(ast: Program, names: Map<string, number>): Set<string> {
  const streams = importsOf(ast, source => source === 'kay', 'stream')
  const sockets = importsOf(ast, source => source === 'kay', 'socket')
  const receivers = new Set<string>()

  const opens = (init: Node): boolean => {
    const call = unwrapped(init)

    if (call.type !== 'CallExpression')
      return false

    const { callee } = call

    if (callee.type === 'Identifier')
      return streams.locals.has(callee.name) || sockets.locals.has(callee.name)

    return callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && (callee.property.name === 'stream' || callee.property.name === 'socket') && (streams.namespaces.has(callee.object.name) || sockets.namespaces.has(callee.object.name))
  }

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && opens(node.init) && names.get(node.id.name) === 1)
      receivers.add(node.id.name)
  })

  return receivers
}

// `.onOpen(reconnected => ...)` of a stream or a socket, `.onOpen(({ reconnected }) => ...)` since 1.92: the hook is told one object, as every hook is, and the old argument, a boolean, reads as true for the object.
// An arrow of one plain parameter gets `{ reconnected: parameter }`, a function reference is wrapped, and any other callback is reported with no fix.
export async function streamOpen(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-stream-open', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-stream-open', ON_OPEN, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      const receivers = sourceReceivers(ast, bindings(ast))

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.optional || node.callee.type !== 'MemberExpression' || node.callee.computed)
          return

        const { object, property } = node.callee

        if (object.type !== 'Identifier' || !receivers.has(object.name) || property.type !== 'Identifier' || property.name !== 'onOpen' || node.arguments.length !== 1)
          return

        const [argument] = node.arguments as [Node]
        const message = '`onOpen` of a stream or a socket is told `{ reconnected }` since 1.92, the one object argument every hook takes; the boolean it was told reads as true for the object, so a callback testing it runs on every open'
        const help = 'write `.onOpen(({ reconnected }) => ...)`'
        const { start, end } = argument
        const here = base + start

        // No parameter, or an object pattern, is the new form already.
        if (argument.type === 'ArrowFunctionExpression' && (argument.params.length === 0 || argument.params[0]?.type === 'ObjectPattern'))
          return

        if (argument.type === 'Identifier') {
          report(here, base + end, message, help, [{ start: here, end: base + end, text: `({ reconnected }) => ${argument.name}(reconnected)` }])

          return
        }

        const [param] = argument.type === 'ArrowFunctionExpression' ? argument.params : []

        if (argument.type === 'ArrowFunctionExpression' && argument.params.length === 1 && param?.type === 'Identifier' && !annotated(param)) {
          const parenthesized = text.slice(start, param.start).includes('(')

          report(here, base + end, message, help, [{ start: base + param.start, end: base + param.end, text: parenthesized ? `{ reconnected: ${param.name} }` : `({ reconnected: ${param.name} })` }])

          return
        }

        report(here, base + end, message, help, null)
      })
    }
  })
}

// `.on(fn)` of a stream or a socket, `.onData(({ value }) => ...)` since 1.92: the one hook every source hands its data through.
// Only a receiver the file binds once to a call of `stream` or `socket` from `kay` is known to be one, as `kay check` reads no types; an arrow of one parameter gets `{ value: parameter }`, any other callback is wrapped, and a spread, or a callback naming `value` itself, is reported with no fix.
export async function streamOn(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-stream-on', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-stream-on', ON, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      const receivers = sourceReceivers(ast, bindings(ast))

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.optional || node.callee.type !== 'MemberExpression' || node.callee.computed)
          return

        const { object, property } = node.callee

        if (object.type !== 'Identifier' || !receivers.has(object.name) || property.type !== 'Identifier' || property.name !== 'on' || node.arguments.length !== 1)
          return

        const [argument] = node.arguments as [Node]
        const rename = { start: base + property.start, end: base + property.end, text: 'onData' }
        const message = '`.on(fn)` of a stream or a socket is `.onData(({ value }) => ...)` since 1.92, the one hook every source hands its data through; the old name works until 1.95'
        const help = 'write `.onData(({ value }) => ...)`'

        if (argument.type === 'SpreadElement') {
          report(rename.start, rename.end, message, help, null)

          return
        }

        const source = text.slice(argument.start, argument.end)

        if (argument.type === 'ArrowFunctionExpression' && argument.params.length === 0) {
          report(rename.start, rename.end, message, help, [rename])

          return
        }

        const [param] = argument.type === 'ArrowFunctionExpression' ? argument.params : []

        if (argument.type === 'ArrowFunctionExpression' && argument.params.length === 1 && param && param.type !== 'RestElement' && !annotated(param)) {
          const written = text.slice(param.start, param.end)
          const parenthesized = text.slice(argument.start, param.start).includes('(')

          report(rename.start, rename.end, message, help, [rename, { start: base + param.start, end: base + param.end, text: parenthesized ? `{ value: ${written} }` : `({ value: ${written} })` }].toSorted((a, b) => a.start - b.start))

          return
        }

        if (VALUE.test(source)) {
          report(rename.start, rename.end, message, help, null)

          return
        }

        report(rename.start, rename.end, message, help, [rename, { start: base + argument.start, end: base + argument.end, text: argument.type === 'Identifier' ? `({ value }) => ${source}(value)` : `({ value }) => (${source})(value)` }])
      })
    }
  })
}
