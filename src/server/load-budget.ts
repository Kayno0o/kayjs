import type { Rendering, RenderOptions } from './render'
import { unansweredLoads } from '../runtime/load-scope'
import { kayLog } from '../runtime/log'
import { loadBudgetMs } from './config-limits'
import { projectPath } from './render-document'

// The refreshed loads development already warned of, by route, so a button asking for one does not fill the log.
const warnedLoads = new Set<string>()

// What development tells of a page's loads once they settled: a refresh asked of a load none answers to, and loads past their budget.
export function warnAboutLoads(file: string, files: string[], timings: number[] | undefined, took: number, rendering: Rendering, options: RenderOptions): void {
  for (const name of unansweredLoads(rendering.ctx.request)) {
    if (warnedLoads.has(`${file} ${name}`))
      continue

    warnedLoads.add(`${file} ${name}`)
    kayLog('warn', `a refresh asked for the load \`${name}\`, which no load the build read in this route's page or layouts answers to (the binding of a top-level \`const ${name} = await ...\` in a server fence): nothing was refreshed for it`)
  }

  warnSlowLoads(file, files, timings, took, rendering, options)
  warnSlowLayout(files, timings, rendering, options)
}

// In development, a layout whose load takes longer than the page's own loads, and than `observe.loadBudget`, is warned of in the log and the dev tool, naming its file and both times: the page waits for it as long as the layout does.
function warnSlowLayout(files: string[], timings: number[] | undefined, rendering: Rendering, options: RenderOptions): void {
  const budget = loadBudgetMs(options.observe?.loadBudget)

  if (budget === undefined || timings === undefined || files.length < 2)
    return

  const pageMs = timings[files.length - 1] ?? 0
  let slowest = -1

  for (const [index, ms] of timings.slice(0, -1).entries()) {
    if (ms !== undefined && ms > budget && ms > pageMs && (slowest === -1 || ms > timings[slowest]!))
      slowest = index
  }

  if (slowest === -1)
    return

  const layout = { file: projectPath(files[slowest]!), ms: timings[slowest]!, pageMs, budget }

  rendering.slow = { ...rendering.slow, slowLayout: layout }
  kayLog('warn', `the load of the layout ${layout.file} took ${Math.round(layout.ms)} ms, longer than the ${Math.round(pageMs)} ms of the page's own loads (and over the ${budget} ms of \`observe.loadBudget\`): the page waits for it. Start it unawaited and stream it with an \`await\` block, or cache it`)
}

// In development, a page whose loads together outlast `observe.loadBudget` is warned of in the log and the dev tool, naming the slowest load: the page waits for them all before anything is sent.
export function warnSlowLoads(file: string, files: string[], timings: number[] | undefined, took: number, rendering: Rendering, options: RenderOptions): void {
  const budget = loadBudgetMs(options.observe?.loadBudget)

  if (budget === undefined || timings === undefined || took <= budget)
    return

  let slowest = -1

  for (const [index, ms] of timings.entries()) {
    if (ms !== undefined && (slowest === -1 || ms > timings[slowest]!))
      slowest = index
  }

  if (slowest === -1)
    return

  const slow = { file: projectPath(files[slowest]!), ms: timings[slowest]!, took, budget }

  rendering.slow = { ...rendering.slow, slow }
  kayLog('warn', `the loads of ${projectPath(file)} took ${Math.round(took)} ms, over the ${budget} ms of \`observe.loadBudget\`; the slowest, \`load-${slowest}\` (${slow.file}), took ${Math.round(slow.ms)} ms. The page waits for every load before it sends anything: start what the first paint does not need unawaited and read it in an \`await\` block, or cache it`)
}
