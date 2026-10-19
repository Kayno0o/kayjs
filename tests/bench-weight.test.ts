import { cp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { eagerJs, lazyChunks } from './eager-js'

const ROOT = resolve(import.meta.dir, '..')
// A copy at a path of its own, as bench/markup.test.ts and `bench:check:kay` build the bench app in place at the same time; the same path every run, as Bun hashes chunk names from it, with bench/shared beside it for the app's relative imports.
const COPY = join(ROOT, '.kay/scratch/bench-weight/bench')
const APP = join(COPY, 'apps/kay')
const DIST = join(APP, '.kay/client/dist')
const BASELINE = join(ROOT, 'bench/weight.json')
// The gzip bytes a page may grow by before the baseline is raised, for the few bytes a chunk name or path moves the output by.
// The baseline counts with Bun.gzipSync's default level, a little above gzip -9.
const SLACK = 40

interface Weight { gzip: number, files: number, lazy: string[] }
interface Manifest { entry: string, entryImports: string[], islands: Record<string, string[]> }

// The islands each bench page hydrates: the products page the counter, the table page the table.
const PAGES: Record<string, string> = { products: 'components/counter.kay', table: 'components/table.kay' }

describe('the bench app\'s JS', () => {
  it('weighs no more, in bytes and in files, than the recorded baseline for each page', async () => {
    await rm(COPY, { recursive: true, force: true })
    await cp(join(ROOT, 'bench/apps/kay'), APP, { recursive: true, filter: source => !source.endsWith('/.kay') })
    await cp(join(ROOT, 'bench/shared'), join(COPY, 'shared'), { recursive: true })

    const build = Bun.spawn([process.execPath, join(ROOT, 'src/cli.ts'), 'build', APP, '--no-check', '--quiet'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

    expect(code, errors).toBe(0)

    const manifest = await Bun.file(join(APP, '.kay/client/manifest.json')).json() as Manifest
    const baseline = await Bun.file(BASELINE).json() as Record<string, Weight>

    for (const [page, island] of Object.entries(PAGES)) {
      const chunks = manifest.islands[island]

      expect(chunks, `${island} is no island of the bench app`).toBeDefined()

      const urls = [manifest.entry, ...manifest.entryImports, ...chunks!]
      const loaded = await eagerJs(urls, async url => Bun.file(join(DIST, url.replace(/^\/_kay\//, ''))).text())
      const gzip = loaded.values().reduce((sum, { size }) => sum + size, 0)
      const expected = baseline[page]!
      const detail = `the ${page} page loads ${gzip} gzip bytes in ${loaded.size} files (${[...loaded.keys()].join(', ')}), baseline ${expected.gzip} in ${expected.files}: raise bench/weight.json only for a cost the change justifies`

      expect(loaded.size, detail).toBeLessThanOrEqual(expected.files)
      expect(gzip, detail).toBeLessThanOrEqual(expected.gzip + SLACK)
      // A chunk the entry imports dynamically is fetched when something asks for it; a new one is checked not to be asked for on every page, such as on idle, before it is listed.
      expect(lazyChunks([...loaded.values()].map(({ code }) => code)), `${page} imports a chunk on demand that the baseline does not list`).toEqual(expected.lazy)
    }
  }, 120_000)
})
