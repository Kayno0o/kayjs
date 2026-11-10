import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, Program } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const ON_OPEN = /\bonOpen\b/

function annotated(param: Node): boolean {
  const { typeAnnotation } = param as { typeAnnotation?: Node | null }

  return typeAnnotation !== undefined && typeAnnotation !== null
}

// Every name the program binds, counted, so one bound twice is not taken for either.
export function bindings(program: Program): Map<string, number> {
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

// The names the file binds once to a call of one of `calls` from `kay`, the only receivers known to be one as `kay check` reads no types.
export function boundOnce(ast: Program, names: Map<string, number>, ...calls: [string, ...string[]]): Set<string> {
  const imported = calls.map(name => ({ name, ...importsOf(ast, source => source === 'kay', name) }))
  const receivers = new Set<string>()

  const opens = (init: Node): boolean => {
    const call = unwrapped(init)

    if (call.type !== 'CallExpression')
      return false

    const { callee } = call

    if (callee.type === 'Identifier')
      return imported.some(({ locals }) => locals.has(callee.name))

    return callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && imported.some(({ name, namespaces }) => name === (callee.property as { name: string }).name && namespaces.has((callee.object as { name: string }).name))
  }

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && opens(node.init) && names.get(node.id.name) === 1)
      receivers.add(node.id.name)
  })

  return receivers
}

function sourceReceivers(ast: Program, names: Map<string, number>): Set<string> {
  return boundOnce(ast, names, 'stream', 'socket')
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

        // A function reference may take either form, which the call site does not tell.
        if (argument.type === 'Identifier') {
          report(here, base + end, message, help, null)

          return
        }

        const [param] = argument.type === 'ArrowFunctionExpression' ? argument.params : []

        if (argument.type === 'ArrowFunctionExpression' && argument.params.length === 1 && param?.type === 'Identifier' && !annotated(param)) {
          const parenthesized = text.slice(start, param.start).includes('(')

          report(here, base + end, message, help, [{ start: base + param.start, end: base + param.end, text: parenthesized ? `{ reconnected: ${param.name} }` : `({ reconnected: ${param.name} })` }])

          return
        }

        // An annotation naming an object is the new form.
        if (param && annotated(param) && text.slice(param.start, param.end).includes('{'))
          return

        report(here, base + end, message, help, null)
      })
    }
  })
}
