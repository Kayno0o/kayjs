import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { ServedProject } from './shadow-types'
import { parse } from '@babel/parser'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all'])
const NODE_MODULES = /[\\/]node_modules[\\/]/

// With `mcp`, the routes of the API modules whose `detail` sets both `tool` and `hide`.
// Only a route written with an inline handler and an object literal of options is read: `app.get('/x', () => ..., { detail: ... })`; a handler or options held in a variable are left out.
export async function mcpRoutes(options: CheckOptions, { apiModules }: ServedProject): Promise<CheckDiagnostic[]> {
  const contradicted = lintLevel('hidden-tool', options.lints)

  if (options.mcp === undefined || options.mcp === false || contradicted === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const module of apiModules) {
    if (NODE_MODULES.test(module.file))
      continue

    const source = await Bun.file(module.file).text()

    for (const route of routesOf(source)) {
      const label = `${route.method.toUpperCase()} ${route.path}`

      if (route.hidden && route.tool)
        found.push({ file: module.file, ...positionAt(source, route.at.start!), end: route.at.end!, message: `The route \`${label}\` sets both \`hide\` and \`tool\`: a hidden route is no tool`, help: 'drop `hide` to offer it as a tool, or `tool` to keep it hidden', code: 'hidden-tool', severity: contradicted === 'warn' ? 'warning' : 'error' })
    }
  }

  return found
}

interface ReadRoute {
  // The `.get` in the call, where the route is reported.
  at: t.Node
  method: string
  path: string
  hidden: boolean
  tool: boolean
}

function routesOf(source: string): ReadRoute[] {
  let ast: t.File

  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  }
  catch {
    return []
  }

  const routes: ReadRoute[] = []

  const scope = apiScope(ast)

  walk(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.type !== 'Identifier' || !ROUTE_METHODS.has(node.callee.property.name))
      return

    if (!fromApi(node.callee.object, scope))
      return

    const [path, handler, hooks] = node.arguments

    if (path === undefined || handler === undefined || (path.type !== 'StringLiteral' && path.type !== 'TemplateLiteral') || (handler.type !== 'ArrowFunctionExpression' && handler.type !== 'FunctionExpression'))
      return

    routes.push({ at: node.callee.property, method: node.callee.property.name, path: path.type === 'StringLiteral' ? path.value : source.slice(path.start! + 1, path.end! - 1), ...readHooks(hooks) })
  })

  return routes
}

function readHooks(hooks: t.CallExpression['arguments'][number] | undefined): Pick<ReadRoute, 'hidden' | 'tool'> {
  if (hooks === undefined || hooks.type !== 'ObjectExpression' || hooks.properties.some(property => property.type !== 'ObjectProperty'))
    return { hidden: false, tool: false }

  const detail = hooks.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && keyName(property) === 'detail')

  if (detail === undefined || detail.value.type !== 'ObjectExpression' || detail.value.properties.some(property => property.type !== 'ObjectProperty'))
    return { hidden: false, tool: false }

  const entries = detail.value.properties as t.ObjectProperty[]
  const hide = entries.find(property => keyName(property) === 'hide')?.value
  const tool = entries.find(property => keyName(property) === 'tool')?.value

  return {
    hidden: hide?.type === 'BooleanLiteral' && hide.value,
    // Anything but a literal `false` offers the route, or may.
    tool: tool !== undefined && !(tool.type === 'BooleanLiteral' && !tool.value),
  }
}

interface ApiScope {
  // The local names `api` is imported as from `kay/server`.
  imports: Set<string>
  // The local names of `import * as x from 'kay/server'`.
  namespaces: Set<string>
  // The names holding an instance, and the functions of the file returning one.
  names: Set<string>
  helpers: Set<string>
}

// Whether `node` is a call of `api` or of a helper returning one, or a chain of calls on it, or a name holding one: a `cache.get('k', () => ...)` is no route.
function fromApi(node: t.Node, scope: ApiScope): boolean {
  let current = node

  while (current.type === 'CallExpression' && current.callee.type === 'MemberExpression' && !isNamespaceApi(current.callee, scope))
    current = current.callee.object

  if (current.type === 'CallExpression') {
    const { callee } = current

    return callee.type === 'MemberExpression' ? isNamespaceApi(callee, scope) : callee.type === 'Identifier' && (scope.imports.has(callee.name) || scope.helpers.has(callee.name))
  }

  return current.type === 'Identifier' && scope.names.has(current.name)
}

function isNamespaceApi(callee: t.MemberExpression, scope: ApiScope): boolean {
  return !callee.computed && callee.object.type === 'Identifier' && scope.namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'api'
}

// What the file holds of `api()`: its import names, then, until nothing new turns up, the names declared or assigned one and the functions returning one.
function apiScope(ast: t.File): ApiScope {
  const scope: ApiScope = { imports: new Set(), namespaces: new Set(), names: new Set(), helpers: new Set() }

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay/server' || statement.importKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier')
        scope.namespaces.add(specifier.local.name)
      else if (specifier.type === 'ImportSpecifier' && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'api')
        scope.imports.add(specifier.local.name)
    }
  }

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
function returnsApi(fn: t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration, scope: ApiScope): boolean {
  if (fn.body.type !== 'BlockStatement')
    return fromApi(fn.body, scope)

  let found = false

  const visit = (node: t.Node) => {
    if (node !== fn.body && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'ObjectMethod' || node.type === 'ClassMethod'))
      return

    if (node.type === 'ReturnStatement' && node.argument && fromApi(node.argument, scope))
      found = true

    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key.endsWith('Comments'))
        continue

      for (const child of Array.isArray(value) ? value : [value]) {
        if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string')
          visit(child as t.Node)
      }
    }
  }

  visit(fn.body)

  return found
}

function keyName(property: t.ObjectProperty): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : undefined
}

function walk(node: t.Node, visit: (node: t.Node) => void): void {
  visit(node)

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments'))
      continue

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string')
        walk(child as t.Node, visit)
    }
  }
}
