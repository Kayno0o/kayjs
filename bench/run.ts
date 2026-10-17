// kay against Solid, Svelte, Astro, Next.js and Nuxt, `bun run bench`, written to bench/results.md: it drives Chromium, the one BUN_CHROME_PATH names or the one `bunx playwright-core install chromium` downloads.
import type { Browser } from 'playwright-core'
import type { LoadResult, OperationResult } from './browser'
import type { BuildResult } from './build'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { APPS, IN_PROCESS_APPS } from './apps'
import { assertHydrated, launch, measureLoad, measureOperations, serve } from './browser'
import { buildAll, BUILDS } from './build'
import { kilobytes, medianOf, milliseconds, seconds, table } from './format'
import { clientRows, PATHS, serverMarkup } from './markup'

interface SsrResult {
  avg: number
  p50: number
  p99: number
}

interface AppResult {
  ssr: SsrResult | undefined
  products: LoadResult
  table: LoadResult
  operations: OperationResult[]
}

const NANOSECONDS_PER_MS = 1e6
const DEFAULT_RUNS = 3
// Single runs disagree by a third on some operations and flip close winners, so each value is the median of several full runs.
const { values: { runs: runsOption } } = parseArgs({ options: { runs: { type: 'string', default: String(DEFAULT_RUNS) } } })
const RUNS = Number(runsOption)

if (!Number.isInteger(RUNS) || RUNS < 1)
  throw new Error(`--runs takes a whole number of runs, not ${runsOption}`)

// Every app but kay lives in its own package; install them on first run.
async function installApps() {
  for (const app of APPS.filter(name => name !== 'kay')) {
    const dir = join(import.meta.dir, 'apps', app)

    if (!existsSync(join(dir, 'node_modules')) && await Bun.spawn([process.execPath, 'install', '--frozen-lockfile'], { cwd: dir, stdout: 'inherit', stderr: 'inherit' }).exited !== 0)
      throw new Error(`bun install failed in ${dir}`)
  }
}

// Measuring only means something when every app renders the same thing, on the server and in the browser.
async function assertSameMarkup(browser: Browser) {
  const renders: { what: string, markup: string[] }[] = []

  // One path at a time: each kay process builds its client into the app's one `.kay/client` as it boots, which two at once would clear under each other.
  for (const path of PATHS)
    renders.push({ what: path, markup: await serverMarkup(path) })

  renders.push({ what: 'the table rows', markup: await clientRows(browser) })

  for (const { what, markup: [kay, ...others] } of renders) {
    for (const [index, markup] of others.entries()) {
      if (markup !== kay)
        throw new Error(`${APPS[index + 1]} renders ${what} differently from kay; run \`bun run bench:test\` for the diff`)
    }
  }
}

async function ssr(app: string): Promise<SsrResult> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'ssr.ts'), app], { stdout: 'pipe', stderr: 'inherit', env: { ...process.env, NODE_ENV: 'production' } })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  if (code !== 0)
    throw new Error(`server rendering ${app} failed`)

  return JSON.parse(output) as SsrResult
}

// Each value next to how far it is from the best of the row, the way the js-framework-benchmark prints it.
function relative(values: number[], format: (value: number) => string, higherIsBetter = false): string[] {
  const best = higherIsBetter ? Math.max(...values) : Math.min(...values)

  return values.map((value) => {
    if (value === best || best === 0)
      return `**${format(value)}**`

    return `${format(value)} (${(higherIsBetter ? best / value : value / best).toFixed(2)}x)`
  })
}

function loadRows(apps: AppResult[], page: 'products' | 'table'): string[][] {
  return [
    ['JS shipped (gzip)', ...relative(apps.map(app => app[page].js.gzip), kilobytes)],
    ['JS shipped (raw)', ...relative(apps.map(app => app[page].js.raw), kilobytes)],
    ['JS files', ...apps.map(app => String(app[page].js.files))],
    ['HTML (gzip)', ...relative(apps.map(app => app[page].html.gzip), kilobytes)],
    ['HTML (raw)', ...relative(apps.map(app => app[page].html.raw), kilobytes)],
    ['script (ms)', ...relative(apps.map(app => app[page].script), milliseconds)],
    ['style (ms)', ...relative(apps.map(app => app[page].style), milliseconds)],
    ['layout (ms)', ...relative(apps.map(app => app[page].layout), milliseconds)],
    ['JS heap', ...relative(apps.map(app => app[page].heap), kilobytes)],
  ]
}

function report(apps: AppResult[], builds: BuildResult[], environment: string[]): string {
  const renders = apps.flatMap(app => app.ssr ? [app.ssr] : [])

  return [
    '# Benchmark: kay, SolidJS, Svelte, Astro, Next.js and Nuxt',
    '',
    ...environment.map(line => `- ${line}`),
    '',
    `Every app renders the same markup from the same data, checked before measuring, table rows included: kay, Solid and Svelte behind the same Elysia server, Astro and Nuxt through their own request handlers called in-process, Next through its Node request handler on a local port. Bold is the best of a row, the factor how far a value is from it. Reproduce with \`bun run bench${RUNS === DEFAULT_RUNS ? '' : ` --runs ${RUNS}`}\`.`,
    '',
    'What differs by design:',
    '',
    '- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages\' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.',
    '- Nuxt hydrates the whole page too, the products coming from an API route into its payload. Astro hydrates its counter and table as SolidJS islands. Next renders server components and hydrates its client ones, the counter and table, streaming the component payload with the page.',
    '- Each table is written the way its framework\'s js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`. Astro\'s island is the Solid table, Next keeps rows and selection in one reducer with memoised rows, Nuxt keeps a shallow ref of plain rows memoised with `v-memo`.',
    '',
    '## Build',
    '',
    `A clean production build of each app, run ${RUNS} ${RUNS === 1 ? 'time' : 'times'} before anything else is timed, the wall time the median. kay is built as \`kay build\` runs it, \`kay check\` included, and with \`--no-check\`, as \`astro build\` and the rest check nothing (Next's build type-checks the app as it goes). Size is what the build deploys, server and client output, without the dependencies it runs on, source maps and the precompressed copies kay writes beside its files; gzip is each file compressed alone.`,
    '',
    table(['', ...BUILDS.map(build => build.name)], [
      ['build time', ...relative(builds.map(build => build.wall), seconds)],
      ['output (gzip)', ...relative(builds.map(build => build.gzip), kilobytes)],
      ['output (raw)', ...relative(builds.map(build => build.raw), kilobytes)],
      ['output files', ...builds.map(build => String(build.files))],
    ]),
    '',
    'What is counted:',
    '',
    '- kay: `.kay/client/dist` (the browser bundle, a chunk per island) and `.kay/client/pages` (the prerendered pages). Its server is not bundled: Bun runs the app\'s sources, so it adds nothing here.',
    '- Solid and Svelte: `dist`, the browser bundle `Bun.build` writes. Their server code is compiled in memory as the server starts, so it adds nothing here.',
    '- Astro: `dist`, its server entry and its client assets. Next: `.next` without `cache`, `diagnostics`, `types` and the build traces and file lists; its server needs `next` from `node_modules` to run. Nuxt: `.output`, the Nitro server with the dependencies it traced, and `public`.',
    '',
    '## Server rendering',
    '',
    'The products page (layout, 500 products, one counter) rendered in-process through the app\'s request handler, measured by mitata. Next is left out: it serves only through its own HTTP server, so its renders would carry a socket round trip the others never pay.',
    '',
    table(['', ...IN_PROCESS_APPS], [
      ['renders/s', ...relative(renders.map(ssr => 1e9 / ssr.avg), value => value.toFixed(0), true)],
      ['mean (ms)', ...relative(renders.map(ssr => ssr.avg / NANOSECONDS_PER_MS), milliseconds)],
      ['p50 (ms)', ...relative(renders.map(ssr => ssr.p50 / NANOSECONDS_PER_MS), milliseconds)],
      ['p99 (ms)', ...relative(renders.map(ssr => ssr.p99 / NANOSECONDS_PER_MS), milliseconds)],
    ]),
    '',
    '## Products page in Chromium',
    '',
    'Medians of fresh loads with an empty cache: Chromium\'s main-thread time up to network idle, hydration in script and the first render in style and layout. DOMContentLoaded is left out: it swings between about 25 and 70 ms across identical loads of the same app.',
    '',
    table(['', ...APPS], loadRows(apps, 'products')),
    '',
    '## Table page in Chromium',
    '',
    table(['', ...APPS], loadRows(apps, 'table')),
    '',
    '## Table operations',
    '',
    'The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. The result is checked after every microtask, then every task, so a frame Chromium renders in between is never counted.',
    '',
    table(['operation', ...APPS], apps[0]!.operations.map((operation, index) => [operation.name, ...relative(apps.map(app => app.operations[index]!.median), milliseconds)])),
    '',
  ].join('\n')
}

async function version(app: string, name: string): Promise<string> {
  const manifest = await Bun.file(join(import.meta.dir, app === 'kay' ? '../node_modules' : `apps/${app}/node_modules`, name, 'package.json')).json() as { version: string }

  return `${name} ${manifest.version}`
}

async function measure(browser: Browser, run: number): Promise<AppResult[]> {
  const of = RUNS > 1 ? ` (run ${run} of ${RUNS})` : ''
  const ssrResults = new Map<string, SsrResult>()

  for (const app of IN_PROCESS_APPS) {
    console.error(`server rendering: ${app}${of}`)
    ssrResults.set(app, await ssr(app))
  }

  const results: AppResult[] = []

  for (const app of APPS) {
    const server = await serve(app)

    try {
      console.error(`browser: ${app}${of}`)
      await assertHydrated(browser, server.url)
      results.push({
        ssr: ssrResults.get(app),
        products: await measureLoad(browser, server.url),
        table: await measureLoad(browser, `${server.url}/table`),
        operations: await measureOperations(browser, server.url),
      })
    }
    finally {
      server.stop()
    }
  }

  return results
}

await installApps()

// Before anything is timed, and apart from it: a build uses every core.
const builds = await buildAll(RUNS, name => console.error(`building: ${name}`))

const browser = await launch()

try {
  console.error('checking markup')
  await assertSameMarkup(browser)

  const runs: AppResult[][] = []

  for (let run = 1; run <= RUNS; run++)
    runs.push(await measure(browser, run))

  const results = medianOf(runs)

  const environment = [
    `${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} threads`,
    `Bun ${Bun.version}, Chromium ${browser.version()} headless`,
    `${await version('kay', 'kay')}, ${await version('solid', 'solid-js')}, ${await version('svelte', 'svelte')}, ${await version('astro', 'astro')}, ${await version('next', 'next')}, ${await version('nuxt', 'nuxt')}`,
    `run on ${new Date().toISOString().slice(0, 10)}${RUNS > 1 ? `, each value the median of ${RUNS} runs` : ''}`,
  ]
  const markdown = report(results, builds, environment)

  await Bun.write(join(import.meta.dir, 'results.md'), markdown)
  console.log(markdown)
}
finally {
  await browser.close()
}
