import type { CheckDiagnostic, CheckOptions } from '.'
import type { ServedProject } from './shadow-types'
import { lintLevel } from '../compiler/lints'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'

const HELP = 'add a `_guard.ts` to its directory or one above it, or, if anyone may reach it, set `guards: false`'

// On a site with `requireGuards`, what the server answers 403 for: each page, layout with actions, endpoint and API module of the app no guard covers that does not set `guards: false`.
export async function unguardedRoutes(options: CheckOptions, { routes, endpoints, apiModules }: ServedProject): Promise<CheckDiagnostic[]> {
  const level = lintLevel('unguarded-route', options.lints)

  if (options.requireGuards !== true || level === 'allow')
    return []

  const report = (file: string, message: string, help = HELP): CheckDiagnostic => ({ file, line: 1, column: 1, message, help, code: 'unguarded-route', severity: level === 'warn' ? 'warning' : 'error' })
  const found: CheckDiagnostic[] = []
  const layouts = new Map<string, boolean>()
  const modules = new Set<string>()

  for (const route of routes) {
    if (route.guards.length === 0 && route.open !== true)
      found.push(report(route.file, `No guard covers \`${route.pattern}\`, so the server refuses it`, `${HELP} in its \`page\``))

    for (const [index, layout] of route.layouts.entries()) {
      const access = route.layoutAccess?.[index]

      layouts.set(layout, access !== undefined && (access.guards.length > 0 || access.open === true))
    }

    for (const [index, module] of (route.actionModules ?? []).entries()) {
      const access = route.actionAccess?.[index]

      modules.add(module)
      layouts.set(module, access !== undefined && (access.guards.length > 0 || access.open === true))
    }
  }

  for (const [layout, guarded] of layouts) {
    const source = guarded ? '' : await Bun.file(layout).text()
    const actions = guarded ? [] : analyzeServer(source, parseKay(source).server)?.actionNames ?? []

    if (actions.length > 0)
      found.push(report(layout, `No guard covers the actions of this ${modules.has(layout) ? 'module' : 'layout'}, ${actions.map(name => `\`${name}\``).join(', ')}, so the server refuses them`, `${HELP} in its \`page\``))
  }

  for (const endpoint of endpoints) {
    if (endpoint.guards.length === 0 && endpoint.open !== true)
      found.push(report(endpoint.file, `No guard covers \`${endpoint.pattern}\`, so the server refuses it`, `${HELP} in \`export const page\``))
  }

  for (const module of apiModules) {
    if (module.guards.length === 0 && module.open !== true)
      found.push(report(module.file, `No guard covers \`${module.mount}\`, so the server refuses its routes`, `${HELP} in its \`api()\` options`))
  }

  return found
}

// With `mcp`, each action that is a tool, has a honeypot, a minimum time or a proof of work, and sits under no guard: an agent skips what those ask of a person.
export async function unguardedTools(options: CheckOptions, { routes }: ServedProject): Promise<CheckDiagnostic[]> {
  const level = lintLevel('unguarded-tool', options.lints)

  if (options.mcp !== true || level === 'allow')
    return []

  const guarded = new Map<string, boolean>()

  for (const route of routes) {
    guarded.set(route.file, route.guards.length > 0)

    for (const [index, layout] of route.layouts.entries())
      guarded.set(layout, (route.layoutAccess?.[index]?.guards.length ?? 0) > 0)

    for (const [index, module] of (route.actionModules ?? []).entries())
      guarded.set(module, (route.actionAccess?.[index]?.guards.length ?? 0) > 0)
  }

  const found: CheckDiagnostic[] = []

  for (const [file, covered] of guarded) {
    if (covered)
      continue

    const source = await Bun.file(file).text()

    for (const { name, botProtected } of analyzeServer(source, parseKay(source).server)?.toolActions ?? []) {
      if (botProtected)
        found.push({ file, line: 1, column: 1, message: `The tool action \`${name}\` has bot protection and no guard covers it, so an agent calls it without the form that protection asks of a person`, help: 'add a `_guard.ts` to its directory or one above it, or drop the protection for a `rateLimit`', code: 'unguarded-tool', severity: level === 'warn' ? 'warning' : 'error' })
    }
  }

  return found
}
