// Eager JS of the bench and example pages, held against the committed baseline in scripts/bundle-weight.json.

import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { KayPlugin } from '@kayjs/kay'
import { analyzeBundleWeights, build } from '@kayjs/kay/build'
import { fail, parse, runMain } from '@kaynooo/cli-kit'
import { regions, spa } from '../packages/plugin-spa/src/index'

const ROOT = resolve(import.meta.dir, '..')
const BASELINE = join(import.meta.dir, 'bundle-weight.json')
const TOLERANCE = 100
// Each app under its own name; `bench-app (spa)` adds spa(), whose client entry every page loads, islands or not.
const APPS: { name: string, dir: string, plugins?: () => KayPlugin[] }[] = [
  { name: 'bench-app', dir: 'bench-app' },
  { name: 'bench-app (spa)', dir: 'bench-app', plugins: () => [regions(), spa()] },
  { name: 'examples/noticeboard', dir: 'examples/noticeboard' },
  { name: 'examples/showcase', dir: 'examples/showcase' },
  { name: 'docs', dir: 'docs' },
]

type Weights = Record<string, Record<string, number>>

const USAGE = 'bun run bench:weight [options]: builds the bench and example apps and compares each page\'s gzipped eager JS with scripts/bundle-weight.json'

// Each app's routes and their gzipped eager JS in bytes; `report` also prints kay's --analyze report per app.
async function measure(report: boolean): Promise<Weights> {
  const weights: Weights = {}
  for (const app of APPS) {
    const dir = join(ROOT, app.dir)
    if (!existsSync(dir))
      continue
    const outDir = '.kay-weight-tmp'
    if (report)
      console.log(`\n>>> ${app.name}`)
    try {
      const manifest = await build({ root: dir, outDir, minify: true, prerender: false, copyPublic: false, analyze: report, plugins: app.plugins?.() })
      const routes = analyzeBundleWeights(manifest, join(dir, outDir, 'client')).routes
      weights[app.name] = Object.fromEntries(routes.map(r => [r.path, r.jsGzip]))
    }
    finally {
      rmSync(join(dir, outDir), { recursive: true, force: true })
    }
  }
  return weights
}

// One line per page whose weight moved, was added or went away, then the pages grown past the tolerance.
function compare(baseline: Weights, current: Weights): { lines: string[], grown: string[] } {
  const lines: string[] = []
  const grown: string[] = []
  for (const app of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const was = baseline[app] ?? {}
    const now = current[app] ?? {}
    for (const page of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const before = was[page]
      const after = now[page]
      if (before === after)
        continue
      const name = `${app} ${page}`
      if (before === undefined)
        lines.push(`${name}: new, ${after} B`)
      else if (after === undefined)
        lines.push(`${name}: gone, was ${before} B`)
      else
        lines.push(`${name}: ${before} B -> ${after} B (${after > before ? '+' : ''}${after - before} B)`)
      if (before !== undefined && after !== undefined && after - before > TOLERANCE)
        grown.push(`${name} grew ${after - before} B`)
    }
  }
  return { lines, grown }
}

process.exitCode = await runMain({
  name: 'bundle-weight',
  usage: false,
  run: async (args) => {
    const { values } = parse(args, USAGE, {
      check: { type: 'boolean', description: `fail when a page's eager JS grows more than ${TOLERANCE} B past the baseline (CI runs it)` },
      update: { type: 'boolean', description: 'record the current weights as the baseline, to commit with the change that moved them' },
    }, { exits: [[0, 'no page grew past the baseline'], [1, 'a page grew past it'], [2, 'a usage error']] })

    const current = await measure(values.check !== true && values.update !== true)
    if (values.update === true) {
      await Bun.write(BASELINE, `${JSON.stringify(current, null, 2)}\n`)
      console.log(`wrote ${BASELINE.slice(ROOT.length + 1)}`)
      return 0
    }

    const baseline = (await Bun.file(BASELINE).json()) as Weights
    const { lines, grown } = compare(baseline, current)
    console.log(lines.length === 0 ? 'every page weighs what the baseline says' : lines.join('\n'))
    if (values.check === true && grown.length > 0)
      return fail(`${grown.join(', ')}, past the ${TOLERANCE} B tolerance`, 1, 'make the page lighter, or record the growth with `bun run bench:weight --update` and commit scripts/bundle-weight.json with the change')
    return 0
  },
})
