import type { Size } from './size-table'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { eagerJs, scriptUrls } from './eager-js'
import { compare, growth, table } from './size-table'

// The gzipped JS each tracked page loads up front, against the baseline in bench/sizes.json: `bun scripts/sizes.ts` fails when a page grew past the tolerance of scripts/size-table.ts, `--update` records the sizes measured now, `--report` prints the table and never fails (CI).
// Each page is measured in a process of its own, one after the other, as a process serves one project and a build is the heavy part.
// The baseline stays where it was set, so growth adds up against it and the commit that crosses the tolerance accepts all of it with `--update`.
const ROOT = resolve(import.meta.dir, '..')
const BASELINE = join(ROOT, 'bench/sizes.json')
const SCRATCH = join(ROOT, '.kay/scratch')
const BASE = '/repo'
const CLIENT_PREFIX = /^\/_kay\//

const PAGES = ['static', 'i18n-links', 'live-values', 'bench-products', 'bench-table'] as const

type Page = typeof PAGES[number]

// The bench app's pages and the island each hydrates.
const BENCH: Record<string, string> = { 'bench-products': 'components/counter.kay', 'bench-table': 'components/table.kay' }

function total(loaded: Map<string, { size: number }>): Size {
  return { gzip: loaded.values().reduce((sum, { size }) => sum + size, 0), files: loaded.size }
}

// A copy at a path of its own, the same every run, as Bun hashes chunk names from it.
async function copyOf(name: string, from: string): Promise<string> {
  const dir = join(SCRATCH, `sizes-${name}`)

  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await cp(from, dir, { recursive: true, filter: source => !source.endsWith('/.kay') })

  return dir
}

// `kay build` in a process of its own, as the CLI is run, without a parallel test run's worker id that would move the build to another folder.
async function build(argv: string[], env: Record<string, string> = {}): Promise<void> {
  const environment = { ...process.env, ...env }

  delete environment.BUN_TEST_WORKER_ID

  const child = Bun.spawn([process.execPath, join(ROOT, 'src/cli.ts'), 'build', ...argv, '--no-check', '--quiet'], { cwd: ROOT, env: environment, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    throw new Error(`kay build ${argv.join(' ')} exited with ${code}: ${out}${err}`)
}

async function staticHome(): Promise<Size> {
  const fixture = await copyOf('static', join(ROOT, 'tests/fixtures/static'))
  const out = join(SCRATCH, 'sizes-static-out')
  // The host a page links an image of, which the export downloads.
  const remote = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(join(fixture, 'src/hero.png'))) })

  try {
    await rm(out, { recursive: true, force: true })
    await build([relative(ROOT, fixture), '--static', '--outdir', out], { NODE_ENV: 'development', KAY_TEST_REMOTE_ORIGIN: `http://127.0.0.1:${remote.port}` })

    return total(await eagerJs(scriptUrls(await Bun.file(join(out, 'index.html')).text()), async url => Bun.file(join(out, url.slice(BASE.length))).text()))
  }
  finally {
    await remote.stop(true)
    await rm(out, { recursive: true, force: true })
  }
}

// A page of an app with locales, its one small island importing nothing of kay/i18n.
async function i18nLinks(): Promise<Size> {
  const { browserPath, testSite } = await import('../src/test')
  const copy = relative(process.cwd(), await copyOf('i18n-links', join(ROOT, 'tests/fixtures/i18n')))

  await Bun.write(join(copy, 'src/components/counter.kay'), '---\nimport { signal } from \'kay\'\n\nconst shown = signal(false)\n---\ndiv\n  button(type="button" onClick={() => shown.set(true)}) Show\n  if shown()\n    a.revealed(href="/about") About\n')

  const site = await testSite({ root: copy, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'src/messages' }, typography: false, browser: { path: browserPath() } })

  try {
    return total(await eagerJs(scriptUrls(await (await site.fetch('/en')).text()), async url => (await site.fetch(url)).text()))
  }
  finally {
    await site.close()
  }
}

// The fixture's home page, with islands reading live values, served by a production build.
async function liveValues(): Promise<Size> {
  const root = await copyOf('live-values', join(ROOT, 'tests/fixtures/live-values'))

  await Bun.write(join(root, 'kay.config.ts'), 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n')
  process.env.NODE_ENV = 'production'
  await build([root], { NODE_ENV: 'production' })

  const { Elysia } = await import('elysia')
  const { pages } = await import('../src/server')
  const app = new Elysia().use(await pages({ root, prebuilt: true, log: false, compress: false }))
  const get = async (path: string) => (await app.handle(new Request(`http://localhost${path}`))).text()

  return total(await eagerJs(scriptUrls(await get('/')), get))
}

async function benchPage(page: string): Promise<Size> {
  const copy = join(SCRATCH, 'sizes-bench')
  const app = join(copy, 'bench/apps/kay')
  const dist = join(app, '.kay/client/dist')

  await rm(copy, { recursive: true, force: true })
  await cp(join(ROOT, 'bench/apps/kay'), app, { recursive: true, filter: source => !source.endsWith('/.kay') })
  await cp(join(ROOT, 'bench/shared'), join(copy, 'bench/shared'), { recursive: true })
  await build([app])

  const manifest = await Bun.file(join(app, '.kay/client/manifest.json')).json() as { entry: string, entryImports: string[], islands: Record<string, string[]> }
  const chunks = manifest.islands[BENCH[page]!]

  if (chunks === undefined)
    throw new Error(`${BENCH[page]} is no island of the bench app`)

  return total(await eagerJs([manifest.entry, ...manifest.entryImports, ...chunks], async url => Bun.file(join(dist, url.replace(CLIENT_PREFIX, ''))).text()))
}

async function measureHere(page: Page): Promise<Size> {
  switch (page) {
    case 'static': return staticHome()
    case 'i18n-links': return i18nLinks()
    case 'live-values': return liveValues()
    case 'bench-products':
    case 'bench-table': return benchPage(page)
  }
}

// The bench app builds once for both its pages.
async function measureAll(): Promise<Record<Page, Size>> {
  const sizes = {} as Record<Page, Size>

  for (const page of PAGES) {
    const child = Bun.spawn([process.execPath, import.meta.path, '--measure', page], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    if (code !== 0)
      throw new Error(`measuring ${page} exited with ${code}: ${out}${err}`)

    sizes[page] = JSON.parse(out.slice(out.lastIndexOf('\n{') + 1)) as Size
  }

  return sizes
}

const flag = process.argv[2]

if (flag === '--measure') {
  console.log(`\n${JSON.stringify(await measureHere(process.argv[3] as Page))}`)
  process.exit(0)
}

const baseline = await Bun.file(BASELINE).json() as Record<Page, Size>
const sizes = await measureAll()

if (flag === '--update') {
  await Bun.write(BASELINE, `${JSON.stringify(sizes, null, 2)}\n`)
  console.log(`bench/sizes.json updated:\n${PAGES.map(page => `  ${page} ${baseline[page]?.gzip ?? '-'} -> ${sizes[page].gzip}`).join('\n')}`)
  process.exit(0)
}

const rows = compare(baseline, sizes)
const failure = growth(rows)

console.log(table(rows))

if (flag !== '--report' && failure !== undefined) {
  console.error(`\n${failure}`)
  process.exit(1)
}

if (rows.some(row => row.shrank))
  console.log('\nA page shrank past the tolerance: `bun scripts/sizes.ts --update` records it.')
