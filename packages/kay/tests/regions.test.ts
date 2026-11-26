import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkProject } from '../src/cli/check'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []
function appWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kay-regions-'))
  tempDirs.push(dir)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

const REGION = { 'x-kay-region': 'pane' }
const seen = globalThis as { __regionHeavy?: number }

describe('regions: the server renders only the requested region (#3597)', () => {
  it('answers a region request with its inner HTML alone, skipping layouts, the other regions and their children', async () => {
    const dir = appWith({
      'src/routes/_layout.tsx': `export default function Layout({ children }: { children: unknown }) { return <div id="shell"><nav>LAYOUT</nav>{children}</div> }`,
      'src/routes/index.tsx': `
        import { Region } from '@kayjs/kay'
        import type { RequestContext } from '@kayjs/kay/server'
        function Heavy() { (globalThis as { __regionHeavy?: number }).__regionHeavy = ((globalThis as { __regionHeavy?: number }).__regionHeavy ?? 0) + 1; return <p>HEAVY</p> }
        export function load(ctx: RequestContext) { return { region: ctx.region ?? null } }
        export default function Home({ data }: { data: { region: string | null } }) {
          return (
            <main>
              <h1>Page</h1>
              <Region name="results" class="r"><Heavy /></Region>
              <Region name="pane" aria-label="Detail"><p>pane {String(data.region)}</p></Region>
            </main>
          )
        }
      `,
    })
    const app = await testApp({ root: dir })
    const full = await (await app.get('/')).text()
    expect(full).toContain('<nav>LAYOUT</nav>')
    expect(full).toContain('<div data-kay-region="results" class="r"><p>HEAVY</p></div>')
    expect(full).toContain('<div data-kay-region="pane" aria-label="Detail"><p>pane null</p></div>')
    expect(seen.__regionHeavy).toBe(1)

    const res = await app.get('/', REGION)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>pane pane</p>')
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('x-kay-region')).toBe('pane')
    expect(res.headers.get('vary')).toContain('x-kay-region')
    expect(seen.__regionHeavy).toBe(1)
  })

  it('fails with the fix when the route has no such region or two share a name', async () => {
    const dir = appWith({
      'src/routes/index.tsx': `
        import { Region } from '@kayjs/kay'
        export default function Home() { return <main><Region name="pane"><p>x</p></Region></main> }
      `,
      'src/routes/twice.tsx': `
        import { Region } from '@kayjs/kay'
        export default function Twice() { return <main><Region name="a"><p>1</p></Region><Region name="a"><p>2</p></Region></main> }
      `,

    })
    const errors: string[] = []
    const app = await testApp({ root: dir, onError: (info: { error: unknown }) => { errors.push((info.error as Error).message) } })
    expect((await app.get('/', { 'x-kay-region': 'nope' })).status).toBe(500)
    expect((await app.get('/twice')).status).toBe(500)

    expect(errors).toEqual([
      expect.stringContaining('kay: the route / does not render <Region name="nope">'),
      expect.stringContaining('kay: two <Region name="a"> on one page'),
    ])
  })

  it('resolves a Suspense inside the requested region inline, and waits for none outside it', async () => {
    const dir = appWith({
      'src/routes/index.tsx': `
        import { Region, Suspense } from '@kayjs/kay'
        async function Slow() { await Bun.sleep(5); return <b>slow</b> }
        async function Never() { await Bun.sleep(1500); return <b>late</b> }
        export default function Home() { return <main><Suspense fallback={<i>outside</i>}><Never /></Suspense><Region name="pane"><Suspense fallback={<i>wait</i>}><Slow /></Suspense></Region></main> }
      `,
    })
    const app = await testApp({ root: dir })
    const started = Date.now()
    expect(await (await app.get('/', REGION)).text()).toBe('<b>slow</b>')
    // A boundary outside the region is not waited for.
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('kay check names a region link that targets no region (#3597)', () => {
  it('reports the file and the name, and stays quiet when every target exists or a region name is computed', async () => {
    const config = `
      import { defineConfig } from '@kayjs/kay/config'
      import { regions } from ${JSON.stringify(join(import.meta.dir, '../../plugin-spa/src/index.ts'))}
      export default defineConfig({ plugins: [regions()] })
    `
    const make = (route: string): string => {
      const dir = appWith({ 'kay.config.ts': config, 'src/routes/index.tsx': route })
      mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
      symlinkSync(join(import.meta.dir, '..'), join(dir, 'node_modules/@kayjs/kay'), 'dir')
      return dir
    }
    const page = (target: string, region: string) => `
      import { Region } from '@kayjs/kay'
      export default function Home() { return <main><a href="/?a=1" data-kay-target="${target}">go</a>${region}</main> }
    `
    const broken = await checkProject(make(page('pane', '<Region name="panel"><p>x</p></Region>')), { skipTypecheck: true })
    expect(broken.errors).toEqual([expect.stringContaining('[regions] src/routes/index.tsx: data-kay-target="pane" names no <Region name="pane"> in src/')])
    expect((await checkProject(make(page('pane', '<Region name="pane"><p>x</p></Region>')), { skipTypecheck: true })).errors).toEqual([])
    expect((await checkProject(make(page('pane', '<Region name={String(1)}><p>x</p></Region>')), { skipTypecheck: true })).errors).toEqual([])
  })
})

describe('a region inside another (#3621)', () => {
  const nested = {
    'src/routes/index.tsx': `
      import { Region } from '@kayjs/kay'
      const hits = globalThis as { __sidebar?: number, __list?: number, __pane?: number }
      function Pane() { hits.__pane = (hits.__pane ?? 0) + 1; return <p>pane</p> }
      function Sidebar() { hits.__sidebar = (hits.__sidebar ?? 0) + 1; return <aside>SIDEBAR</aside> }
      function List() { hits.__list = (hits.__list ?? 0) + 1; return <ul><li>one</li></ul> }
      export default function Home() {
        return (
          <main>
            <Region name="results"><Sidebar /><Region name="sets" class="inner"><List /></Region></Region>
            <Region name="pane"><Pane /></Region>
          </main>
        )
      }
    `,
  }
  it('renders the inner region alone when asked for it by its path, and sends nothing of the outer one, and never builds its siblings', async () => {
    const app = await testApp({ root: appWith(nested) })
    const hits = globalThis as { __list?: number, __pane?: number }
    const res = await app.get('/', { 'x-kay-region': 'results/sets' })
    expect(await res.text()).toBe('<ul><li>one</li></ul>')
    expect(res.headers.get('x-kay-region')).toBe('results/sets')
    expect(hits.__list).toBe(1)
    expect(hits.__pane).toBeUndefined()
  })

  it('renders the outer region with a fresh inner wrapper, and the whole page with both', async () => {
    const app = await testApp({ root: appWith(nested) })
    expect(await (await app.get('/', { 'x-kay-region': 'results' })).text()).toBe('<aside>SIDEBAR</aside><div data-kay-region="sets" class="inner"><ul><li>one</li></ul></div>')
    const full = await (await app.get('/')).text()
    expect(full).toContain('<div data-kay-region="results"><aside>SIDEBAR</aside><div data-kay-region="sets" class="inner">')
  })
})
