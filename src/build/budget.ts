import type { CheckDiagnostic } from '../check/index'
import type { LintLevels } from '../compiler/lints'
import type { Route } from '../server/routes'
import type { ModuleSize, RouteSize, SizeReport } from './report'
import { lintLevel } from '../compiler/lints'

// A size in bytes, or a string with its unit: `'20kb'`, `'1.5mb'`, `'800b'`.
export type ByteSize = number | `${number}${'b' | 'kb' | 'mb'}`

// The most a page may load, compressed as a host serves it; a key left out sets no limit.
export interface BudgetConfig {
  js?: ByteSize | undefined
  css?: ByteSize | undefined
}

const SIZE_TEXT = /^(\d+(?:\.\d+)?)(b|kb|mb)$/i
const UNIT_BYTES = { b: 1, kb: 1024, mb: 1024 * 1024 }
const SHOWN_MODULES = 3

// The bytes a size stands for; `what` names the option in the error anything else throws.
export function byteSize(value: unknown, what: string): number {
  const text = typeof value === 'string' ? SIZE_TEXT.exec(value) : null
  const fromText = text ? Number(text[1]) * UNIT_BYTES[text[2]!.toLowerCase() as keyof typeof UNIT_BYTES] : Number.NaN
  const bytes = typeof value === 'number' ? value : fromText

  if (!Number.isFinite(bytes) || bytes <= 0)
    throw new Error(`kay: ${what} is ${typeof value === 'string' ? `'${value}'` : String(value)}; it takes a positive size, bytes or a string such as '20kb' or '1.5mb'`)

  return bytes
}

// The routes loading more than `budget` allows, each at its file, with the modules that weigh most in its scripts when the build measured them.
export function budgetLints(budget: BudgetConfig | undefined, lints: LintLevels | undefined, sizes: RouteSize[], routes: Route[], report: SizeReport | undefined): CheckDiagnostic[] {
  const level = lintLevel('over-budget', lints)

  if (budget === undefined || level === 'allow')
    return []

  const limits = { js: budget.js === undefined ? undefined : byteSize(budget.js, '`budget.js`'), css: budget.css === undefined ? undefined : byteSize(budget.css, '`budget.css`') }
  const files = new Map(routes.map(route => [route.pattern, route.file]))
  const found: CheckDiagnostic[] = []

  for (const size of sizes) {
    const file = files.get(size.route)

    if (file === undefined)
      continue

    for (const kind of ['js', 'css'] as const) {
      const limit = limits[kind]

      if (limit === undefined || size[kind] <= limit)
        continue

      const modules = kind === 'js' ? heaviestOf(size, report) : []

      found.push({
        file,
        line: 1,
        column: 1,
        code: 'over-budget',
        severity: level === 'warn' ? 'warning' : 'error',
        message: `\`${size.route}\` ${size.estimated && kind === 'js' ? 'can load' : 'loads'} ${kb(size[kind])} of ${kind === 'js' ? 'JavaScript' : 'CSS'}, over the budget of ${kb(limit)}`,
        note: modules.length > 0 ? `compressed; the modules weighing most, minified: ${modules.map(module => `${module.name} ${kb(module.bytes)}`).join(', ')}` : 'compressed, as a host serves it',
        help: kind === 'js' ? 'import less in the islands this page renders, or raise `budget.js` in kay.config.ts; `kay build --analyze` lists the modules of every island' : 'ship fewer styles on this page, or raise `budget.css` in kay.config.ts',
      })
    }
  }

  return found
}

// The modules of the entry and of the islands a route renders, summed by name, the heaviest first.
function heaviestOf(route: RouteSize, report: SizeReport | undefined): ModuleSize[] {
  if (report === undefined)
    return []

  const bytes = new Map<string, number>()
  const islands = new Set(route.islands)

  for (const modules of [report.entry?.modules, ...report.islands.filter(island => islands.has(island.file)).map(island => island.modules)]) {
    for (const module of modules ?? [])
      bytes.set(module.name, (bytes.get(module.name) ?? 0) + module.bytes)
  }

  return [...bytes].map(([name, size]) => ({ name, bytes: size })).sort((a, b) => b.bytes - a.bytes).slice(0, SHOWN_MODULES)
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}
