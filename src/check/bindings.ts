import type { Node, Program } from '../compiler/estree'
import { unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'

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
