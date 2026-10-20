import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { ParsedApi } from './api-modules'
import type { ServedProject } from './shadow-types'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parsedApiModules } from './api-modules'
import { fromApi } from './api-scope'
import { walk } from './ast'

// The `.ws()` routes of the API modules with a `body` and no `response`, whose messages an island's `socket()` receives as `unknown`.
// Only a route written with an object literal of options and no spread is read.
export async function untypedSockets(options: CheckOptions, { apiModules }: ServedProject): Promise<CheckDiagnostic[]> {
  const level = lintLevel('untyped-socket', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const module of await parsedApiModules(apiModules)) {
    const { source } = module

    for (const { at, path } of untypedRoutes(module)) {
      found.push({
        file: module.file,
        ...positionAt(source, at.start!),
        end: at.end!,
        message: `The websocket route \`${path}\` has a \`body\` and no \`response\`, so an island's \`socket()\` receives its messages as \`unknown\``,
        help: 'add `response: <rooms>.response` when it sends through `rooms()`, or a `response` schema, so `last()` and `on()` are typed',
        code: 'untyped-socket',
        severity: level === 'warn' ? 'warning' : 'error',
      })
    }
  }

  return found
}

function untypedRoutes({ source, ast, scope }: ParsedApi): { at: t.Node, path: string }[] {
  const routes: { at: t.Node, path: string }[] = []

  walk(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'ws' || !fromApi(node.callee.object, scope))
      return

    const [path, hooks] = node.arguments

    if ((path?.type !== 'StringLiteral' && path?.type !== 'TemplateLiteral') || hooks?.type !== 'ObjectExpression' || hooks.properties.some(property => property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod'))
      return

    const names = new Set(hooks.properties.map(optionName))

    // A computed key may be the `response`.
    if (names.has(null))
      return

    if (names.has('body') && !names.has('response'))
      routes.push({ at: node.callee.property, path: path.type === 'StringLiteral' ? path.value : source.slice(path.start! + 1, path.end! - 1) })
  })

  return routes
}

// The name of an option written as `name: value`, `name() {}` or `'name': value`, or null for one that is computed.
function optionName(property: t.ObjectProperty | t.ObjectMethod | t.SpreadElement): string | null {
  if (property.type === 'SpreadElement' || property.computed)
    return null

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : null
}
