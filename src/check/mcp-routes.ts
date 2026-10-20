import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { ParsedApi } from './api-modules'
import type { ServedProject } from './shadow-types'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parsedApiModules } from './api-modules'
import { fromApi, keyName } from './api-scope'
import { walk } from './ast'

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all'])

// With `mcp`, the routes of the API modules whose `detail` sets both `tool` and `hide`.
// Only a route written with an inline handler and an object literal of options is read: `app.get('/x', () => ..., { detail: ... })`; a handler or options held in a variable are left out.
export async function mcpRoutes(options: CheckOptions, { apiModules }: ServedProject): Promise<CheckDiagnostic[]> {
  const contradicted = lintLevel('hidden-tool', options.lints)

  if (options.mcp === undefined || options.mcp === false || contradicted === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const module of await parsedApiModules(apiModules)) {
    const { source } = module

    for (const route of routesOf(module)) {
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

function routesOf({ source, ast, scope }: ParsedApi): ReadRoute[] {
  const routes: ReadRoute[] = []

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
