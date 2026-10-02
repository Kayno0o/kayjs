import type { LoadResult, OperationResult } from './browser'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { APPS } from './apps'
import { assertHydrated, launch, measureLoad, measureOperations, serve } from './browser'
import { renderVisible } from './markup'

interface SsrResult {
  bytes: number
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

    if (!existsSync(join(dir, 'node_modules')))
      await Bun.spawn([process.execPath, 'install', '--frozen-lockfile'], { cwd: dir, stdout: 'inherit', stderr: 'inherit' }).exited
  }
}

async function assertSameMarkup() {
  for (const path of ['/', '/table']) {
    const [kay, ...others] = await Promise.all(APPS.map(async app => renderVisible(app, path)))

    for (const [index, markup] of others.entries()) {
      if (markup !== kay)
        throw new Error(`${APPS[index + 1]} renders ${path} differently from kay; run \`bun run bench:test\` for the diff`)
    }
  }
}

async function ssr(app: string): Promise<SsrResult> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'ssr.ts'), app], { stdout: 'pipe', stderr: 'inherit' })

  return JSON.parse(await new Response(child.stdout).text()) as SsrResult
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
    ['DOMContentLoaded (ms)', ...relative(apps.map(app => app[page].domContentLoaded), milliseconds)],
    ['load (ms)', ...relative(apps.map(app => app[page].load), milliseconds)],
    ['script time (ms)', ...relative(apps.map(app => app[page].script), milliseconds)],
    ['JS heap', ...relative(apps.map(app => app[page].heap), kilobytes)],
  ]
}

function report(apps: AppResult[], environment: string[]): string {
  return [
    '# Benchmark: kay, SolidJS and Svelte',
    '',
    ...environment.map(line => `- ${line}`),
    '',
    'Every app renders the same markup from the same data behind the same Elysia server, checked before measuring. Solid and Svelte hydrate the whole page from serialized data; kay hydrates its islands only. Bold is the best of a row, the factor how far a value is from it. Reproduce with `bun run bench`.',
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
    'Medians of fresh loads with an empty cache. Script time is Chromium\'s main-thread JavaScript time up to network idle, hydration included.',
    '',
    table(['', ...APPS], loadRows(apps, 'products')),
    '',
    '## Table page in Chromium',
    '',
    table(['', ...APPS], loadRows(apps, 'table')),
    '',
    '## Table operations',
    '',
    'The js-framework-benchmark keyed operations, median ms over fresh pages: from the click until the DOM holds the result and is laid out, paint excluded.',
    '',
    table(['operation', ...APPS], apps[0]!.operations.map((operation, index) => [operation.name, ...relative(apps.map(app => app.operations[index]!.median), milliseconds)])),
    '',
  ].join('\n')
}

await installApps()
console.error('checking markup')
await assertSameMarkup()

const ssrResults: SsrResult[] = []

for (const app of APPS) {
  console.error(`server rendering: ${app}`)
  ssrResults.push(await ssr(app))
}

const browser = await launch()

try {
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
    'kay on solid-js 2.0.0-rc.13, solid-js 1.9.15, svelte 5.57.1',
    `run on ${new Date().toISOString().slice(0, 10)}`,
  ]
  const markdown = report(results, environment)

  await Bun.write(join(import.meta.dir, 'results.md'), markdown)
  console.log(markdown)
}
finally {
  await browser.close()
}
