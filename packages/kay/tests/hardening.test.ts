import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'
import { scaffoldProject } from '../src/cli/new'
import { compileDom, compileSsr } from '../src/compiler/index'
import { testApp } from '../src/test/index'

const KAY_PKG_DIR = join(import.meta.dir, '..')
const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
function linkKay(dir: string): void {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(KAY_PKG_DIR, join(dir, 'node_modules/kay'), 'dir')
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('Milestone 4: Compiler hardening (spreads, SVG, destructured .map, kay-slot)', () => {
  it('compiles JSX spread attributes on intrinsic elements for SSR and DOM', () => {
    const src = `
      import { signal } from 'kay'
      export function Btn({ label, ...rest }: { label: string, [k: string]: unknown }) {
        return <button type="button" {...rest}>{label}</button>
      }
    `
    const ssr = compileSsr('Btn.tsx', src)
    expect(ssr.code).toContain('__ssrSpread(rest)')

    const dom = compileDom('Btn.tsx', src)
    expect(dom.code).toContain('__omit(__p, ["label"])')
    expect(dom.code).toContain('__spread(')
  })

  it('compiles SVG child root templates with isSvg=true and handles destructured .map()', () => {
    const src = `
      import { signal } from 'kay'
      export function Chart() {
        const pts = signal([{ id: 1, cx: 10 }, { id: 2, cx: 20 }])
        return (
          <svg viewBox="0 0 100 100">
            {pts.value.map(({ id, cx }) => (
              <circle key={id} cx={cx} cy="50" r="5" class={cx > 15 ? 'big' : 'small'} />
            ))}
          </svg>
        )
      }
    `
    const dom = compileDom('Chart.tsx', src)
    expect(dom.code).toContain('__template("<circle cy=\\"50\\" r=\\"5\\"></circle>", true)')
    expect(dom.code).toContain('.value.cx')
  })

  it('executes spread attributes, SVG rendering, and <kay-slot> hydration in DOM', async () => {
    const dir = makeTemp('kay-m4-dom-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })

    writeFileSync(join(dir, 'src/components/Drawer.tsx'), `
      import { signal } from 'kay'
      import type { KayChild } from 'kay'

      export function Drawer({ title, children, ...rest }: { title: string, children?: KayChild, [k: string]: unknown }) {
        const open = signal(true)
        const clicks = signal(0)
        const pts = signal([{ id: 1, x: 10 }, { id: 2, x: 30 }])
        return (
          <section {...rest} data-clicks={clicks.value}>
            <button id="toggle" type="button" onClick={() => { open.value = !open.value; clicks.value++ }}>{title}</button>
            {open.value && <div class="slot-wrap">{children}</div>}
            <svg width="40" height="20">
              {pts.value.map(({ id, x }) => (
                <circle key={id} cx={x} cy="10" r="4" class={clicks.value > 0 ? 'lit' : 'dim'} />
              ))}
            </svg>
          </section>
        )
      }
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Drawer } from '../components/Drawer'
      export default async function Page() {
        return (
          <Drawer title="Details" id="drawer-root" data-kind="panel" className="box">
            <p class="server-only">Rendered on server</p>
          </Drawer>
        )
      }
    `)

    const app = await testApp({ root: dir })
    const res = await app.get('/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('id="drawer-root"')
    expect(html).toContain('data-kind="panel"')
    expect(html).toContain('class="box"')
    expect(html).toContain('<kay-slot><p class="server-only">Rendered on server</p></kay-slot>')
    expect(html).toContain('kay-island,kay-slot{display:contents}')

    // Hydrate in Happy-DOM and verify spread, SVG class update, and <kay-slot> toggle
    GlobalRegistrator.register()
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'dist/manifest.json'), 'utf8'))
      const runtimeAbs = join(dir, 'dist/client', manifest.runtimeScript.replace(/^\/_kay\//, ''))
      const drawerChunk = Object.values(manifest.islands)[0] as string
      const drawerAbs = join(dir, 'dist/client', drawerChunk.replace(/^\/_kay\//, ''))

      const bodyMatch = /<body>([\s\S]*)<\/body>/.exec(html)
      document.body.innerHTML = bodyMatch![1]!

      const islandEl = document.querySelector('kay-island')!
      islandEl.removeAttribute('c')
      const props = JSON.parse(islandEl.getAttribute('p') ?? '{}')
      const slot = islandEl.querySelector('kay-slot')
      expect(slot).not.toBeNull()
      props.children = slot

      const runtimeMod = await import(runtimeAbs) as { hydrate: (el: Element, fn: () => unknown) => () => void }
      const drawerMod = await import(drawerAbs) as { default: (p: Record<string, unknown>) => unknown }
      const dispose = runtimeMod.hydrate(islandEl, () => drawerMod.default(props))

      const sec = islandEl.querySelector('section')!
      expect(sec.getAttribute('data-kind')).toBe('panel')
      expect(sec.getAttribute('class')).toBe('box')
      expect(islandEl.querySelector('.server-only')?.textContent).toBe('Rendered on server')

      // Click toggle -> closes slot AND updates SVG circle class to 'lit'
      const btn = islandEl.querySelector('#toggle') as HTMLButtonElement
      btn.click()
      expect(islandEl.querySelector('.server-only')).toBeNull()
      expect(islandEl.querySelector('circle')?.getAttribute('class')).toBe('lit')

      // Click again -> re-opens and re-inserts preserved server-rendered <kay-slot>!
      btn.click()
      expect(islandEl.querySelector('.server-only')?.textContent).toBe('Rendered on server')

      dispose()
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})

describe('Milestone 4: CSS Modules, public/ static files, and plugins in --compile', () => {
  it('bundles static CSS + CSS Modules (0 KB JS) and serves public/ files with ETag/304', async () => {
    const dir = makeTemp('kay-m4-css-pub-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/styles'), { recursive: true })
    mkdirSync(join(dir, 'public/images'), { recursive: true })

    writeFileSync(join(dir, 'public/robots.txt'), 'User-agent: *\nDisallow:\n')
    writeFileSync(join(dir, 'public/images/dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

    writeFileSync(join(dir, 'src/styles/base.css'), 'body { margin: 0; }\n')
    writeFileSync(join(dir, 'src/styles/card.module.css'), '.card { border: 1px solid #ccc; }\n')

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import '../styles/base.css'
      import styles from '../styles/card.module.css'
      export default async function Home() {
        return <div class={styles.card}>Styled statically</div>
      }
    `)

    const manifest = await build({ root: dir, static: true })
    // Zero JS runtime shipped when there are no islands!
    expect(manifest.runtimeScript).toBeUndefined()
    expect(manifest.styles.length).toBe(2)
    expect(manifest.publicFiles).toEqual(['images/dot.svg', 'robots.txt'])
    // --static copied public files into dist/static/
    expect(existsSync(join(dir, 'dist/static/robots.txt'))).toBe(true)
    expect(existsSync(join(dir, 'dist/static/images/dot.svg'))).toBe(true)

    const app = await testApp({ root: dir, prebuilt: true })
    const pageRes = await app.get('/')
    const html = await pageRes.text()
    expect(html).not.toContain('<script')
    expect(html).toContain('<link rel="stylesheet" href="/_kay/')

    // Extract scoped class name from HTML and verify matching rule exists in bundled CSS!
    const clsMatch = /class="([^"]+)"/.exec(html)
    expect(clsMatch).not.toBeNull()
    const scopedClass = clsMatch![1]!
    expect(scopedClass).toStartWith('card_')

    let allCss = ''
    for (const styleUrl of manifest.styles) {
      const cssRes = await app.get(styleUrl)
      expect(cssRes.status).toBe(200)
      allCss += await cssRes.text()
    }
    expect(allCss).toContain(`.${scopedClass}`)
    expect(allCss).toContain('margin:0')

    // public/ serving + ETag + 304
    const robots = await app.get('/robots.txt')
    expect(robots.status).toBe(200)
    expect(robots.headers.get('content-type')).toContain('text/plain')
    const etag = robots.headers.get('etag')
    expect(etag).toBeTruthy()
    expect(await robots.text()).toContain('User-agent: *')

    const notMod = await app.fetch(new Request('http://localhost/robots.txt', {
      headers: { 'if-none-match': etag! },
    }))
    expect(notMod.status).toBe(304)

    const svg = await app.get('/images/dot.svg')
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
  })

  it('embeds kay.config.ts plugins and public/ assets inside --compile standalone binary', async () => {
    const dir = makeTemp('kay-m4-compile-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'public'), { recursive: true })

    writeFileSync(join(dir, 'public/hello.txt'), 'compiled-public-ok')
    const i18nPath = join(import.meta.dir, '../../plugin-i18n/src/index.ts')
    writeFileSync(join(dir, 'kay.config.ts'), `
      import { defineConfig } from 'kay/server'
      import { i18n } from ${JSON.stringify(i18nPath)}
      export default defineConfig({
        plugins: [
          i18n({
            locales: ['en', 'fr'],
            defaultLocale: 'en',
            messages: { en: { hi: 'Hello binary' }, fr: { hi: 'Bonjour binaire' } },
          }),
        ],
      })
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export default async function Home({ locals }: { locals: { t?: (k: string) => string } }) {
        return <h1>{locals.t ? locals.t('hi') : 'none'}</h1>
      }
    `)

    const binPath = join(dir, 'dist/app-bin')
    await build({ root: dir, compile: binPath })
    expect(existsSync(binPath)).toBe(true)

    const port = 34567 + Math.floor(Math.random() * 5000)
    const proc = Bun.spawn([binPath], {
      env: { ...process.env, PORT: String(port) },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      // Wait for binary to bind
      let ready = false
      for (let i = 0; i < 120; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/hello.txt`)
          if (r.ok) {
            ready = true
            expect(await r.text()).toBe('compiled-public-ok')
            break
          }
        }
        catch {
          await Bun.sleep(25)
        }
      }
      expect(ready).toBe(true)

      const enHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text()
      expect(enHtml).toContain('<html lang="en">')
      expect(enHtml).toContain('<h1>Hello binary</h1>')

      const frHtml = await (await fetch(`http://127.0.0.1:${port}/fr`)).text()
      expect(frHtml).toContain('<html lang="fr">')
      expect(frHtml).toContain('<h1>Bonjour binaire</h1>')

      const localesRes = await (await fetch(`http://127.0.0.1:${port}/_i18n/locales`)).json() as { locales: string[] }
      expect(localesRes.locales).toEqual(['en', 'fr'])
    }
    finally {
      proc.kill()
      await proc.exited
    }
  })
})

describe('Milestone 4: kay new scaffolder & kay check validator', () => {
  it('scaffolds minimal & fullstack templates that build, pass check, and serve correctly', async () => {
    const dir = makeTemp('kay-m4-new-')
    const fullDir = join(dir, 'my-fullstack-app')
    const res = scaffoldProject(fullDir, { template: 'fullstack' })
    linkKay(fullDir)
    expect(res.files).toContain('src/routes/index.tsx')
    expect(res.files).toContain('src/routes/api/health.ts')
    expect(res.files).toContain('src/actions/greet.ts')
    expect(res.files).toContain('public/robots.txt')

    // Refuses overwrite without --force
    expect(() => scaffoldProject(fullDir)).toThrow(/not empty/)

    // kay check passes (skipping tsc since node_modules isn't installed in temp dir)
    const checkOk = await checkProject(fullDir, { skipTypecheck: true })
    expect(checkOk.ok).toBe(true)
    expect(checkOk.checkedFiles).toBeGreaterThanOrEqual(5)

    // Builds and runs cleanly via testApp
    const app = await testApp({ root: fullDir })
    const home = await app.get('/')
    expect(home.status).toBe(200)
    const html = await home.text()
    expect(html).toContain('Welcome to Kay')
    expect(html).toContain('<title>my-fullstack-app</title>')
    expect(html).toContain('<link rel="stylesheet"')

    const health = await app.get('/api/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, runtime: 'bun' })

    const robots = await app.get('/robots.txt')
    expect(robots.status).toBe(200)

    // Inject an illegal interactive async route and verify kay check catches it
    writeFileSync(join(fullDir, 'src/routes/bad.tsx'), `
      import { signal } from 'kay'
      export default async function Bad() {
        const n = signal(0)
        return <div>{n.value}</div>
      }
    `)
    const checkFail = await checkProject(fullDir, { skipTypecheck: true })
    expect(checkFail.ok).toBe(false)
    expect(checkFail.errors.some(e => e.includes('async route component'))).toBe(true)
  })
})
