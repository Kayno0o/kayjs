import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeBundleWeights, build, formatBundleReport } from '../src/build/index'
import { createServer, definePlugin, KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, withCspHashes } from '../src/server/index'
import { createHtmlHeaders } from '../src/server/document'
import { inlineStyleHashes } from '../src/server/security'
import { KAY_STREAM_SCRIPT } from '../src/ssr/context'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('Per-route CSS scoping, strict CSP hashes, and bundle weight report (#3519)', () => {
  it('augments CSP directives with SHA-256 hashes without requiring unsafe-inline', () => {
    const strict = "default-src 'self'; script-src 'self'; style-src 'self'"
    const withIsland = withCspHashes(strict, { styleHashes: [KAY_ISLAND_STYLE_HASH] })
    expect(withIsland).toContain(`style-src 'self' ${KAY_ISLAND_STYLE_HASH}`)
    expect(withIsland).not.toContain("'unsafe-inline'")
    expect(withIsland).toContain("script-src 'self'")

    // Derives missing style-src / script-src from default-src
    const minimal = "default-src 'self'"
    const withBoth = withCspHashes(minimal, {
      styleHashes: [KAY_SUSPENSE_STYLE_HASH],
      scriptHashes: [KAY_STREAM_SCRIPT_HASH],
    })
    expect(withBoth).toContain(`style-src 'self' ${KAY_SUSPENSE_STYLE_HASH}`)
    expect(withBoth).toContain(`script-src 'self' ${KAY_STREAM_SCRIPT_HASH}`)

    // Leaves directives that already allow 'unsafe-inline' untouched
    const loose = "default-src 'self'; style-src 'self' 'unsafe-inline'"
    expect(withCspHashes(loose, { styleHashes: [KAY_ISLAND_STYLE_HASH] })).toBe(loose)
  })

  it('scopes CSS stylesheets per route (layouts, page CSS, island CSS, and 404 fallback) and analyzes route weights', async () => {
    const dir = makeTemp('kay-per-route-css-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    mkdirSync(join(dir, 'src/styles'), { recursive: true })

    const pluginCssPath = join(dir, 'src/styles/plugin-global.css')
    writeFileSync(pluginCssPath, ':root { --k-global: 1; }\n')
    writeFileSync(join(dir, 'src/styles/layout.css'), 'body { margin: 0; }\n')
    writeFileSync(join(dir, 'src/styles/home.css'), '.home-only { color: #111111; }\n')
    writeFileSync(join(dir, 'src/styles/about.css'), '.about-only { color: #222222; }\n')
    writeFileSync(join(dir, 'src/styles/widget.css'), '.widget-only { color: #333333; }\n')

    writeFileSync(join(dir, 'src/components/Widget.tsx'), `
      import { signal } from '@kayjs/kay'
      import '../styles/widget.css'
      export function Widget() {
        const n = signal(0)
        return <button class="widget-only" type="button" onClick={() => n.value++}>{n.value}</button>
      }
    `)

    writeFileSync(join(dir, 'src/routes/_layout.tsx'), `
      import type { KayChild } from '@kayjs/kay'
      import '../styles/layout.css'
      export default function Layout({ children }: { children?: KayChild }) {
        return <div class="shell">{children}</div>
      }
    `)

    writeFileSync(join(dir, 'src/routes/_404.tsx'), `
      export default function NotFound() {
        return <h1>404</h1>
      }
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import '../styles/home.css'
      import { Widget } from '../components/Widget'
      export default async function Home() {
        return <main class="home-only"><Widget /></main>
      }
    `)

    writeFileSync(join(dir, 'src/routes/about.tsx'), `
      import '../styles/about.css'
      export default async function About() {
        return <main class="about-only">About page (0 KB JS)</main>
      }
    `)

    const plugin = { name: 'test-global-css', css: ['src/styles/plugin-global.css'] }
    const manifest = await build({ root: dir, plugins: [plugin] })
    const app = await createServer({ root: dir, plugins: [plugin] })

    const extractStyles = (html: string) =>
      [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]!)

    const cssTextOf = async (urls: string[]) => {
      let combined = ''
      for (const u of urls)
        combined += await (await app.handle(new Request(`http://localhost${u}`))).text()
      return combined
    }

    // 1. Home route gets plugin + layout + home + widget CSS, NOT about CSS
    const homeHtml = await (await app.handle(new Request('http://localhost/'))).text()
    const homeStyles = extractStyles(homeHtml)
    const homeCss = await cssTextOf(homeStyles)
    expect(homeCss).toContain('--k-global')
    expect(homeCss).toContain('margin:0')
    expect(homeCss).toContain('.home-only')
    expect(homeCss).toContain('.widget-only')
    expect(homeCss).not.toContain('.about-only')

    // 2. About route gets plugin + layout + about CSS, NOT home or widget CSS, and 0 JS!
    const aboutHtml = await (await app.handle(new Request('http://localhost/about'))).text()
    const aboutStyles = extractStyles(aboutHtml)
    const aboutCss = await cssTextOf(aboutStyles)
    expect(aboutCss).toContain('--k-global')
    expect(aboutCss).toContain('margin:0')
    expect(aboutCss).toContain('.about-only')
    expect(aboutCss).not.toContain('.home-only')
    expect(aboutCss).not.toContain('.widget-only')
    expect(aboutHtml).not.toContain('<script')

    // 3. 404 page gets plugin + root layout CSS only (no home/about/widget CSS)
    const notFoundRes = await app.handle(new Request('http://localhost/nope'))
    expect(notFoundRes.status).toBe(404)
    const notFoundCss = await cssTextOf(extractStyles(await notFoundRes.text()))
    expect(notFoundCss).toContain('--k-global')
    expect(notFoundCss).toContain('margin:0')
    expect(notFoundCss).not.toContain('.home-only')
    expect(notFoundCss).not.toContain('.about-only')
    expect(notFoundCss).not.toContain('.widget-only')

    // 4. Metafile / bundle weight report reflects per-route JS & CSS accurately
    const weights = analyzeBundleWeights(manifest, join(dir, 'dist/client'))
    const homeRow = weights.routes.find(r => r.path === '/')!
    const aboutRow = weights.routes.find(r => r.path === '/about')!
    expect(homeRow.jsGzip).toBeGreaterThan(0)
    expect(aboutRow.jsGzip).toBe(0)
    expect(aboutRow.cssFiles).toBeLessThan(homeRow.cssFiles)

    const reportText = formatBundleReport(weights)
    expect(reportText).toContain('KAY BUNDLE WEIGHT REPORT')
    expect(reportText).toContain('/about')
  })

  it('auto-injects exact SHA-256 CSP hashes for islands & streaming Suspense with zero inline style attrs', async () => {
    const dir = makeTemp('kay-strict-csp-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })

    writeFileSync(join(dir, 'src/components/Btn.tsx'), `
      import { signal } from '@kayjs/kay'
      export function Btn() {
        const n = signal(0)
        return <button type="button" onClick={() => n.value++}>{n.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/routes/static.tsx'), `
      export default function StaticPage() {
        return <p>No islands, no suspense</p>
      }
    `)
    writeFileSync(join(dir, 'src/routes/island.tsx'), `
      import { Btn } from '../components/Btn'
      export default async function IslandPage() {
        return <Btn />
      }
    `)
    writeFileSync(join(dir, 'src/routes/stream.tsx'), `
      import { Suspense } from '@kayjs/kay'
      async function Delayed() {
        await Bun.sleep(5)
        return <p id="done">Loaded cleanly</p>
      }
      export default function StreamPage() {
        return <Suspense fallback={<p id="fb">Wait</p>}><Delayed /></Suspense>
      }
    `)

    await build({ root: dir })
    const strictCsp = "default-src 'self'; script-src 'self'; style-src 'self'"
    const app = await createServer({ root: dir, security: { csp: strictCsp } })

    // Static page needs no extra CSP hashes
    const staticRes = await app.handle(new Request('http://localhost/static'))
    expect(staticRes.headers.get('content-security-policy')).toBe(strictCsp)

    // Island page automatically gets KAY_ISLAND_STYLE_HASH in style-src (no unsafe-inline)
    const islandRes = await app.handle(new Request('http://localhost/island'))
    const islandCsp = islandRes.headers.get('content-security-policy')!
    expect(islandCsp).toContain(KAY_ISLAND_STYLE_HASH)
    expect(islandCsp).not.toContain("'unsafe-inline'")
    expect(islandCsp).not.toContain(KAY_STREAM_SCRIPT_HASH)

    // Streaming Suspense page automatically gets KAY_SUSPENSE_STYLE_HASH + KAY_STREAM_SCRIPT_HASH
    // and emits zero inline style="..." attributes or per-chunk <script> tags
    const streamRes = await app.handle(new Request('http://localhost/stream'))
    const streamCsp = streamRes.headers.get('content-security-policy')!
    expect(streamCsp).toContain(KAY_SUSPENSE_STYLE_HASH)
    expect(streamCsp).toContain(KAY_STREAM_SCRIPT_HASH)
    expect(streamCsp).not.toContain("'unsafe-inline'")

    const streamHtml = await streamRes.text()
    expect(streamHtml).not.toContain('style="display:contents"')
    expect(streamHtml).toContain('<kay-s id="k-s-0"><p id="fb">Wait</p></kay-s>')
    expect(streamHtml).toContain('<template data-ks="0"><p id="done">Loaded cleanly</p></template>')

    // Execute the fixed KAY_STREAM_SCRIPT in Happy-DOM to verify live DOM swap!
    GlobalRegistrator.register()
    try {
      document.body.innerHTML = '<kay-s id="k-s-0"><p id="fb">Wait</p></kay-s>'
      // eslint-disable-next-line no-new-func
      new Function(KAY_STREAM_SCRIPT)()
      const tpl = document.createElement('template')
      tpl.dataset.ks = '0'
      tpl.innerHTML = '<p id="done">Loaded cleanly</p>'
      document.body.appendChild(tpl)
      await Bun.sleep(10)
      expect(document.getElementById('k-s-0')).toBeNull()
      expect(document.getElementById('done')?.textContent).toBe('Loaded cleanly')
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})

describe('the default CSP lets an app style its pages (#3582)', () => {
  const LAYOUT_STYLE_HASH = `'sha256-ac1R1kU5izDDnXGpZrb2k+Dct4jThB3/YH1VfglrT3I='`
  const HEAD_STYLE_HASH = `'sha256-QRQPRLGyxt3RJiKpYNjpkgHcmHU2PywsfL2e8oI0LQA='`
  const styleSrc = (csp: string | null): string[] => csp?.split(';').map(d => d.trim().split(' ')).find(d => d[0] === 'style-src')?.slice(1) ?? []

  async function styledApp(csp?: string) {
    const dir = makeTemp('kay-style-csp-')
    mkdirSync(join(dir, 'src/routes/item'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/_layout.tsx'), `
      export default function Layout({ children }) {
        return <div><style>{'main{color:red}'}</style><main>{children}</main></div>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export default function Home() {
        return <p style="color:blue">home</p>
      }
    `)
    writeFileSync(join(dir, 'src/routes/_404.tsx'), `
      export default function NotFound() {
        return <p>missing</p>
      }
    `)
    writeFileSync(join(dir, 'src/routes/item/[id].tsx'), `
      export default function Item({ params }) {
        return <p>item {params.id}</p>
      }
    `)
    writeFileSync(join(dir, 'src/routes/pre.tsx'), `
      export const prerender = true
      export default function Pre() {
        return <p>prerendered</p>
      }
    `)
    writeFileSync(join(dir, 'src/routes/head.tsx'), `
      import { Head } from '@kayjs/kay'
      export default function WithHead() {
        return <><Head><style>{'p{margin:0}'}</style></Head><p>head</p></>
      }
    `)
    writeFileSync(join(dir, 'src/routes/stream.tsx'), `
      import { Suspense } from '@kayjs/kay'
      async function Later() {
        await Bun.sleep(1)
        return <p>later</p>
      }
      export default function Stream() {
        return <Suspense fallback={<p>wait</p>}><Later /></Suspense>
      }
    `)
    await build({ root: dir })
    return createServer({ root: dir, ...(csp !== undefined ? { security: { csp } } : {}) })
  }

  it('allows style attributes and hashes every rendered <style> block on each way a page is served', async () => {
    const app = await styledApp()
    for (const path of ['/', '/item/7', '/pre', '/head', '/stream', '/missing']) {
      const res = await app.handle(new Request(`http://localhost${path}`))
      const csp = res.headers.get('content-security-policy')
      expect(csp, path).toContain(`style-src-attr 'unsafe-inline'`)
      expect(styleSrc(csp), path).toContain(LAYOUT_STYLE_HASH)
    }
    const head = await app.handle(new Request('http://localhost/head'))
    expect(styleSrc(head.headers.get('content-security-policy'))).toContain(HEAD_STYLE_HASH)
  })

  it('keeps an app\'s own policy, adding only the hashes of what it renders', async () => {
    const strict = "default-src 'self'; script-src 'self'; style-src 'self'"
    const app = await styledApp(strict)
    const res = await app.handle(new Request('http://localhost/'))
    expect(res.headers.get('content-security-policy')).toBe(`default-src 'self'; script-src 'self'; style-src 'self' ${LAYOUT_STYLE_HASH}`)
  })

  it('never hashes attacker-injected <style> tags from raw() or innerHTML while still hashing compiler & plugin styles (#3625)', async () => {
    const dir = makeTemp('kay-3625-csp-inject-')
    mkdirSync(join(dir, 'src/routes/dyn'), { recursive: true })
    const attackerCss = 'body{background:url(https://evil.example/exfil)}'
    const attackerHash = inlineStyleHashes(`<style>${attackerCss}</style>`)[0]!
    const pluginHeadCss = '.plugin-head{border:1px solid #000}'
    const pluginHeadHash = inlineStyleHashes(`<style>${pluginHeadCss}</style>`)[0]!
    const pluginTransformCss = '.plugin-tx{outline:0}'
    const pluginTransformHash = inlineStyleHashes(`<style>${pluginTransformCss}</style>`)[0]!
    const fallbackCss = '.fb{opacity:.5}'
    const fallbackHash = inlineStyleHashes(`<style>${fallbackCss}</style>`)[0]!

    writeFileSync(join(dir, 'src/routes/_layout.tsx'), `
      export default function Layout({ children }) {
        return <div><style>{'main{color:red}'}</style><main>{children}</main></div>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { raw } from '@kayjs/kay/internal/ssr'
      export default function Home() {
        const injected = '<style>${attackerCss}</style>'
        return <section>{raw(injected)}<div innerHTML={injected} /></section>
      }
    `)
    writeFileSync(join(dir, 'src/routes/dyn/[id].tsx'), `
      export default function Dyn() {
        return <article innerHTML={'<STYLE>${attackerCss}</STYLE>'} />
      }
    `)
    writeFileSync(join(dir, 'src/routes/stream.tsx'), `
      import { Suspense } from '@kayjs/kay'
      async function Later() {
        await Bun.sleep(2)
        return <p>later</p>
      }
      export default function Stream() {
        return (
          <Suspense fallback={<><style>{'${fallbackCss}'}</style><p>wait</p><div innerHTML={'<style>${attackerCss}</style>'} /></>}>
            <Later />
          </Suspense>
        )
      }
    `)
    writeFileSync(join(dir, 'src/routes/_404.tsx'), `
      export default function NotFound() {
        return <div innerHTML={'<style>${attackerCss}</style>missing'} />
      }
    `)

    const plugin = definePlugin({
      name: 'csp-plugin-styles',
      head(doc) {
        doc.add(`<style>${pluginHeadCss}</style>`)
      },
      transformHtml(html) {
        return html.replace('</head>', `<style>${pluginTransformCss}</style></head>`)
      },
    })

    // First verify fast static path (no plugins) does not authorize injected <style>
    await build({ root: dir })
    const fastApp = await createServer({ root: dir })
    for (const path of ['/', '/dyn/1', '/stream', '/missing']) {
      const res = await fastApp.handle(new Request(`http://localhost${path}`))
      const csp = res.headers.get('content-security-policy')!
      expect(styleSrc(csp), path).toContain(LAYOUT_STYLE_HASH)
      expect(styleSrc(csp), path).not.toContain(attackerHash)
    }
    const streamRes = await fastApp.handle(new Request('http://localhost/stream'))
    expect(styleSrc(streamRes.headers.get('content-security-policy'))).toContain(fallbackHash)
    const streamHeadRes = await fastApp.handle(new Request('http://localhost/stream', { method: 'HEAD' }))
    expect(styleSrc(streamHeadRes.headers.get('content-security-policy'))).toContain(LAYOUT_STYLE_HASH)
    expect(styleSrc(streamHeadRes.headers.get('content-security-policy'))).toContain(fallbackHash)

    // With plugin head + transformHtml hooks: plugin styles ARE hashed, preexisting injected <style> is STILL not hashed
    const pluginApp = await createServer({ root: dir, plugins: [plugin] })
    const pluginRes = await pluginApp.handle(new Request('http://localhost/'))
    const pluginCsp = pluginRes.headers.get('content-security-policy')!
    expect(styleSrc(pluginCsp)).toContain(LAYOUT_STYLE_HASH)
    expect(styleSrc(pluginCsp)).toContain(pluginHeadHash)
    expect(styleSrc(pluginCsp)).toContain(pluginTransformHash)
    expect(styleSrc(pluginCsp)).not.toContain(attackerHash)
  })

  it('handles case-insensitive <STYLE> tags in inlineStyleHashes and LRU cache eviction past 256 entries (#3625)', () => {
    const hashes = inlineStyleHashes('<STYLE type="text/css">a{color:red}</STYLE><Style>b{color:blue}</Style>')
    expect(hashes.length).toBe(2)
    expect(hashes).toEqual([
      inlineStyleHashes('<style>a{color:red}</style>')[0]!,
      inlineStyleHashes('<style>b{color:blue}</style>')[0]!,
    ])

    // Evicts least-recently-used entries cleanly past 256 without errors or stale headers
    const htmlHeaders = createHtmlHeaders(undefined, { 'content-security-policy': "default-src 'self'; style-src 'self'" })
    for (let i = 0; i < 300; i++) {
      const h = inlineStyleHashes(`<style>.k${i}{z-index:${i}}</style>`)
      const headers = htmlHeaders(false, false, true, h)
      expect(headers['content-security-policy']).toContain(h[0]!)
    }
  })
})
