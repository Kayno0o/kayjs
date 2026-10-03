import type { Browser } from 'playwright-core'
import type { LoadResult, OperationResult } from './browser'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { APPS } from './apps'
import { assertHydrated, launch, measureLoad, measureOperations, serve } from './browser'
import { clientRows, PATHS, serverMarkup } from './markup'

interface SsrResult {
  avg: number
  p50: number
  p99: number
}

interface AppResult {
  ssr: SsrResult
  products: LoadResult
  table: LoadResult
  operations: OperationResult[]
}

const NANOSECONDS_PER_MS = 1e6

// Solid and Svelte live in their own packages; install them on first run.
async function installApps() {
  for (const app of APPS.filter(name => name !== 'kay')) {
    const dir = join(import.meta.dir, 'apps', app)

    if (!existsSync(join(dir, 'node_modules')) && await Bun.spawn([process.execPath, 'install', '--frozen-lockfile'], { cwd: dir, stdout: 'inherit', stderr: 'inherit' }).exited !== 0)
      throw new Error(`bun install failed in ${dir}`)
  }
}

// Measuring only means something when every app renders the same thing, on the server and in the browser.
async function assertSameMarkup(browser: Browser) {
  const renders = [...await Promise.all(PATHS.map(async path => ({ what: path, markup: await serverMarkup(path) }))), { what: 'the table rows', markup: await clientRows(browser) }]

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

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function milliseconds(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1)
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

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n')
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

function report(apps: AppResult[], environment: string[]): string {
  return [
    '# Benchmark: kay, SolidJS and Svelte',
    '',
    ...environment.map(line => `- ${line}`),
    '',
    'Every app renders the same markup from the same data behind the same Elysia server, checked before measuring, table rows included. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.',
    '',
    'What differs by design:',
    '',
    '- Solid and Svelte hydrate the whole page, so their HTML carries the page data as JSON and their one bundle holds both pages\' components. kay hydrates its islands only and ships one chunk per island, fetched after its entry and shared chunk.',
    '- Each table is written the way its framework\'s js-framework-benchmark entry is: Solid keeps a signal per label and selects rows with `createSelector`, Svelte keeps a `$state` label per row, kay replaces rows immutably under a keyed `for` and selects rows with `selection`.',
    '',
    '## Server rendering',
    '',
    'The products page (layout, 500 products, one counter) rendered in-process through the app\'s request handler, measured by mitata.',
    '',
    table(['', ...APPS], [
      ['renders/s', ...relative(apps.map(app => 1e9 / app.ssr.avg), value => value.toFixed(0), true)],
      ['mean (ms)', ...relative(apps.map(app => app.ssr.avg / NANOSECONDS_PER_MS), milliseconds)],
      ['p50 (ms)', ...relative(apps.map(app => app.ssr.p50 / NANOSECONDS_PER_MS), milliseconds)],
      ['p99 (ms)', ...relative(apps.map(app => app.ssr.p99 / NANOSECONDS_PER_MS), milliseconds)],
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
    'The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded. Every framework waits the same one task after the click before the result is checked.',
    '',
    table(['operation', ...APPS], apps[0]!.operations.map((operation, index) => [operation.name, ...relative(apps.map(app => app.operations[index]!.median), milliseconds)])),
    '',
  ].join('\n')
}

async function version(app: string, name: string): Promise<string> {
  const manifest = await Bun.file(join(import.meta.dir, app === 'kay' ? '../node_modules' : `apps/${app}/node_modules`, name, 'package.json')).json() as { version: string }

  return `${name} ${manifest.version}`
}

await installApps()

const ssrResults: SsrResult[] = []

for (const app of APPS) {
  console.error(`server rendering: ${app}`)
  ssrResults.push(await ssr(app))
}

const browser = await launch()

try {
  console.error('checking markup')
  await assertSameMarkup(browser)

  const results: AppResult[] = []

  for (const [index, app] of APPS.entries()) {
    const server = await serve(app)

    try {
      console.error(`browser: ${app}`)
      await assertHydrated(browser, server.url)
      results.push({
        ssr: ssrResults[index]!,
        products: await measureLoad(browser, server.url),
        table: await measureLoad(browser, `${server.url}/table`),
        operations: await measureOperations(browser, server.url),
      })
    }
    finally {
      server.stop()
    }
  }

  const environment = [
    `${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} threads`,
    `Bun ${Bun.version}, Chromium ${browser.version()} headless`,
    `kay on ${await version('kay', 'solid-js')}, ${await version('solid', 'solid-js')}, ${await version('svelte', 'svelte')}`,
    `run on ${new Date().toISOString().slice(0, 10)}`,
  ]
  const markdown = report(results, environment)

  await Bun.write(join(import.meta.dir, 'results.md'), markdown)
  console.log(markdown)
}
finally {
  await browser.close()
}
