import { cp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { eagerJs, lazyChunks } from '../scripts/eager-js'

const ROOT = resolve(import.meta.dir, '..')
// A copy at a path of its own, as bench/markup.test.ts and `bench:check:kay` build the bench app in place at the same time; the same path every run, as Bun hashes chunk names from it, with bench/shared beside it for the app's relative imports.
const COPY = join(ROOT, '.kay/scratch/bench-weight/bench')
const APP = join(COPY, 'apps/kay')
const DIST = join(APP, '.kay/client/dist')
// The chunks the bench pages can load on demand: a new one is checked not to be asked for on every page, such as on idle, before it is listed. The sizes are held by scripts/sizes.ts.
const LAZY = ['fetch-island', 'forms', 'hydrate-when', 'live-cache', 'live-props', 'page-swap', 'prefetch', 'report-error', 'static-slots']

interface Manifest { entry: string, entryImports: string[], islands: Record<string, string[]> }

// The islands each bench page hydrates: the products page the counter, the table page the table.
const PAGES: Record<string, string> = { products: 'components/counter.kay', table: 'components/table.kay' }

describe('the bench app\'s JS', () => {
  it('loads no chunk on demand that is not listed, for each page', async () => {
    await rm(COPY, { recursive: true, force: true })
    await cp(join(ROOT, 'bench/apps/kay'), APP, { recursive: true, filter: source => !source.endsWith('/.kay') })
    await cp(join(ROOT, 'bench/shared'), join(COPY, 'shared'), { recursive: true })

    // Without the parallel run's worker id, which would move the build to .kay/client-<id>.
    const env = { ...process.env }

    delete env.BUN_TEST_WORKER_ID
    const build = Bun.spawn([process.execPath, join(ROOT, 'src/cli.ts'), 'build', APP, '--no-check', '--quiet'], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

    expect(code, errors).toBe(0)

    const manifest = await Bun.file(join(APP, '.kay/client/manifest.json')).json() as Manifest

    for (const [page, island] of Object.entries(PAGES)) {
      const chunks = manifest.islands[island]

      expect(chunks, `${island} is no island of the bench app`).toBeDefined()

      const urls = [manifest.entry, ...manifest.entryImports, ...chunks!]
      const loaded = await eagerJs(urls, async url => Bun.file(join(DIST, url.replace(/^\/_kay\//, ''))).text())

      expect(lazyChunks([...loaded.values()].map(({ code }) => code)), `${page} imports a chunk on demand that the test does not list`).toEqual(LAZY)
    }
  }, 120_000)
})
