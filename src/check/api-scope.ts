import type { ArrowFunctionExpression, Function, MemberExpression, ObjectProperty, ObjectPropertyKind } from 'oxc-parser'
import type { Node, Program } from '../compiler/estree'
import { childrenOf, importsOf, walk } from './ast'

export interface ApiScope {
  // The local names `api` is imported as from `kay/server`.
  imports: Set<string>
  // The local names of `import * as x from 'kay/server'`.
  namespaces: Set<string>
  // The names holding an instance, and the functions of the file returning one.
  names: Set<string>
  helpers: Set<string>
}

// Whether `node` is a call of `api` or of a helper returning one, or a chain of calls on it, or a name holding one: a `cache.get('k', () => ...)` is no route.
export function fromApi(node: Node, scope: ApiScope): boolean {
  let current = node

  while (current.type === 'CallExpression' && current.callee.type === 'MemberExpression' && !isNamespaceApi(current.callee, scope))
    current = current.callee.object

  if (current.type === 'CallExpression') {
    const { callee } = current

    return callee.type === 'MemberExpression' ? isNamespaceApi(callee, scope) : callee.type === 'Identifier' && (scope.imports.has(callee.name) || scope.helpers.has(callee.name))
  }

  return current.type === 'Identifier' && scope.names.has(current.name)
}

function isNamespaceApi(callee: MemberExpression, scope: ApiScope): boolean {
  return !callee.computed && callee.object.type === 'Identifier' && scope.namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'api'
}

// What the file holds of `api()`: its import names, then, until nothing new turns up, the names declared or assigned one and the functions returning one.
export function apiScope(ast: Program): ApiScope {
  const { locals, namespaces } = importsOf(ast, from => from === 'kay/server', 'api')
  const scope: ApiScope = { imports: locals, namespaces, names: new Set(), helpers: new Set() }

  const add = (set: Set<string>, name: string) => {
    if (set.has(name))
      return false

    set.add(name)

    return true
  }

  let changed = true

  while (changed) {
    changed = false

    walk(ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
        if (fromApi(node.init, scope))
          changed = add(scope.names, node.id.name) || changed
        else if ((node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression') && returnsApi(node.init, scope))
          changed = add(scope.helpers, node.id.name) || changed
      }
      else if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier' && fromApi(node.right, scope)) {
        changed = add(scope.names, node.left.name) || changed
      }
      else if (node.type === 'FunctionDeclaration' && node.id && returnsApi(node, scope)) {
        changed = add(scope.helpers, node.id.name) || changed
      }
    })
  }

  return scope
}

// Whether a function returns an instance: an expression body, or a `return` of its own, not one of a function nested in it.
function returnsApi(fn: ArrowFunctionExpression | Function, scope: ApiScope): boolean {
  if (fn.body === null)
    return false

  if (fn.body.type !== 'BlockStatement')
    return fromApi(fn.body, scope)

  let found = false

  const visit = (node: Node) => {
    if (node !== fn.body && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration'))
      return

    if (node.type === 'ReturnStatement' && node.argument && fromApi(node.argument, scope))
      found = true

    for (const child of childrenOf(node))
      visit(child)
  }

  visit(fn.body)

  return found
}

// A property written as `name: value` or `name`, not a method, getter, setter or spread.
export function isPlain(property: ObjectPropertyKind): property is ObjectProperty {
  return property.type === 'Property' && !property.method && property.kind === 'init'
}

export function keyName(property: ObjectProperty): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'Literal' && typeof property.key.value === 'string' ? property.key.value : undefined
}
