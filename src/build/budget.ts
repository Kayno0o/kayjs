import type { CheckDiagnostic } from '../check/index'
import type { LintLevels } from '../compiler/lints'
import type { ByteSize } from '../runtime/byte-size'
import type { Route } from '../server/routes'
import type { RouteFootprint } from './footprint'
import type { Grade } from './footprint-models'
import type { ModuleSize, RouteSize, SizeReport } from './report'
import { KayError } from '../compiler/errors'
import { lintLevel } from '../compiler/lints'
import { byteSize } from '../runtime/byte-size'
import { gradeBelow, GRADES } from './footprint-models'
import { kb } from './report'

// The most a page may load, compressed as a host serves it; a key left out sets no limit.
export interface BudgetConfig {
  js?: ByteSize | undefined
  css?: ByteSize | undefined
  // The whole page: its HTML, stylesheets, scripts, images and fonts.
  weight?: ByteSize | undefined
  // The worst EcoIndex grade a page may have, `'C'` failing a D to G.
  grade?: Grade | undefined
}

const SHOWN_MODULES = 3

// Throws for a limit that is no positive size, whatever the lint's level.
export function checkBudget(budget: BudgetConfig | undefined): void {
  if (budget?.js !== undefined)
    byteSize(budget.js, '`budget.js`')

  if (budget?.css !== undefined)
    byteSize(budget.css, '`budget.css`')

  if (budget?.weight !== undefined)
    byteSize(budget.weight, '`budget.weight`')

  if (budget?.grade !== undefined && !GRADES.includes(budget.grade))
    throw new KayError('config-invalid', `kay: \`budget.grade\` is ${JSON.stringify(budget.grade)}; it takes an EcoIndex grade, ${GRADES.map(grade => `'${grade}'`).join(', ')}`)
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

// The routes whose heaviest measured page weighs more than `budget.weight` or grades worse than `budget.grade`, each at its file. A route with no page prerendered has nothing measured, so nothing to check.
export function footprintLints(budget: BudgetConfig | undefined, lints: LintLevels | undefined, footprints: RouteFootprint[], routes: Route[]): CheckDiagnostic[] {
  const level = lintLevel('over-budget', lints)

  if (budget === undefined || level === 'allow' || (budget.weight === undefined && budget.grade === undefined))
    return []

  const limit = budget.weight === undefined ? undefined : byteSize(budget.weight, '`budget.weight`')
  const files = new Map(routes.map(route => [route.pattern, route.file]))
  const found: CheckDiagnostic[] = []
  const severity = level === 'warn' ? 'warning' : 'error'

  for (const { route, path, pages, footprint } of footprints) {
    const file = files.get(route)

    if (file === undefined || footprint === undefined)
      continue

    const where = pages > 1 ? `its heaviest page, \`${path}\`` : 'the page'
    const parts = Object.entries(footprint.parts).filter(([, bytes]) => bytes > 0).sort((a, b) => b[1] - a[1]).map(([name, bytes]) => `${name} ${kb(bytes)}`).join(', ')

    if (limit !== undefined && footprint.weight > limit)
      found.push({ file, line: 1, column: 1, code: 'over-budget', severity, message: `\`${route}\` weighs ${kb(footprint.weight)} whole, over the budget of ${kb(limit)}`, note: `${where}, compressed as a host serves it: ${parts}`, help: 'load fewer or smaller images and fonts, or raise `budget.weight` in kay.config.ts; `kay build` lists what each page weighs' })

    if (budget.grade !== undefined && gradeBelow(footprint.grade, budget.grade))
      found.push({ file, line: 1, column: 1, code: 'over-budget', severity, message: `\`${route}\` has EcoIndex grade ${footprint.grade} (${footprint.score}), worse than the budget of ${budget.grade}`, note: `${where}: ${footprint.dom} DOM elements, ${footprint.requests} requests, ${kb(footprint.weight)}`, help: 'cut the elements, requests or weight the note lists, or relax `budget.grade` in kay.config.ts' })
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
