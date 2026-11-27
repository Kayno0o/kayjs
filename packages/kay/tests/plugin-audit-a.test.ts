import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { content, defineCollection, renderMarkdown, renderRss } from '../../plugin-content/src/index'
import { registeredCollections } from '../../plugin-content/src/collection'
import { sanitizeMarkdownHtml } from '../../plugin-content/src/sanitize'
import { i18n } from '../../plugin-i18n/src/index'
import { images, optimizeImageFile, shareCard } from '../../plugin-images/src/index'
import { ENCODE_SLOTS } from '../../plugin-images/src/pipeline'
import { seo } from '../../plugin-seo/src/index'
import { regions, spa } from '../../plugin-spa/src/index'
import { tailwind } from '../../plugin-tailwind/src/index'
import { ui } from '../../ui/src/plugin'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'
import { resolvePlugins } from '../src/plugins/index'
import { createServer } from '../src/server/index'
import { testApp } from '../src/test/index'

const CONTENT_PKG = join(import.meta.dir, '../../plugin-content/src/index.ts')
const IMAGES_PKG = join(import.meta.dir, '../../plugin-images/src/index.ts')
const REPO_ROOT = join(import.meta.dir, '../../..')
const tempDirs: string[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// Build a minimal valid uncompressed PNG with explicit width & height in its IHDR chunk.
function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13) // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes[24] = 8 // bit depth
  bytes[25] = 2 // color type RGB
  return bytes
}

const VALID_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('Issue #3635 Part 1 — Cross-plugin audit fixes', () => {
  describe('1. @kayjs/spa — CSP styles, history coordination, redirects, DOM clobbering, dir, auth links', () => {
    it('emits kay-island.css in spa() and regions() builds for CSP-safe island styles', async () => {
      const dir = makeTemp('kay-spa-css-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Static</h1> }\n')

      const manifest = await build({ root: dir, plugins: [spa(), regions()] })
      expect(manifest.assets).toContain('kay-island.css')
      expect(manifest.styles.filter(s => s.endsWith('/kay-island.css'))).toHaveLength(1)
      const css = readFileSync(join(dir, 'dist/client/kay-island.css'), 'utf8')
      expect(css).toContain('kay-island')
      expect(css).toContain('display:contents')
    })

    it('syncs <html dir>, skips kay-island inline <style>, falls back on blocked CSP <style>, and skips auth links', async () => {
      GlobalRegistrator.register({ url: 'http://localhost/', settings: { handleDisabledFileLoadingAsSuccess: true } })
      const origFetch = globalThis.fetch
      const fetchedUrls: string[] = []
      const assignedUrls: string[] = []
      let reloadCount = 0
      try {
        Object.defineProperty(window.location, 'assign', {
          configurable: true,
          value: (u: string) => {
            assignedUrls.push(u)
          },
        })
        Object.defineProperty(window.location, 'reload', {
          configurable: true,
          value: () => {
            reloadCount++
          },
        })

        document.documentElement.setAttribute('lang', 'en')
        document.documentElement.removeAttribute('dir')
        document.head.innerHTML = '<title>Home</title><style>.shared{color:black}</style>'
        document.body.innerHTML = [
          '<nav data-kay-prefetch>',
          '<a id="oauth" href="/auth/oauth/google">Google</a>',
          '<a id="verify" href="/auth/verify-email?token=one-time">Verify</a>',
          '<a id="magic" href="/auth/magic-link/verify?token=one-time">Magic</a>',
          '<a id="fr-oauth" href="/fr/auth/oauth/github">FR GitHub</a>',
          '<a id="ar" href="/ar">Arabic</a>',
          '</nav>',
          '<main><h1>Home</h1></main>',
        ].join('')

        const strictCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-test'"
        const pages: Record<string, { html: string, csp?: string }> = {
          'http://localhost/ar': {
            html: '<!DOCTYPE html><html lang="ar" dir="rtl"><head><title>Arabic</title><style>.shared{color:black}</style><style>kay-island,kay-slot{display:contents}</style></head><body><main><h1>مرحبا</h1></main></body></html>',
            csp: strictCsp,
          },
          'http://localhost/en': {
            html: '<!DOCTYPE html><html lang="en"><head><title>English</title><style>.shared{color:black}</style></head><body><main><h1>Hello</h1></main></body></html>',
            csp: strictCsp,
          },
          'http://localhost/styled': {
            html: '<!DOCTYPE html><html lang="en"><head><title>Styled</title><style>.page-only{color:crimson}</style></head><body><main><h1>Styled</h1></main></body></html>',
            csp: strictCsp,
          },
        }

        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          fetchedUrls.push(url)
          const page = pages[url] ?? { html: '<html><body>404</body></html>' }
          const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
          if (page.csp)
            headers['content-security-policy'] = page.csp
          const res = new Response(page.html, { status: 200, headers })
          Object.defineProperty(res, 'url', { value: url })
          return res
        }) as typeof fetch

        const spaClient = await import(`../../plugin-spa/src/client.ts?auditA=${Date.now()}`)

        // 1. Auth one-time & OAuth links are NOT intercepted on click and NOT prefetched on hover
        for (const id of ['oauth', 'verify', 'magic', 'fr-oauth']) {
          const el = document.getElementById(id)!
          el.dispatchEvent(new Event('pointerover', { bubbles: true }))
          const clickEv = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
          el.dispatchEvent(clickEv)
          expect(clickEv.defaultPrevented).toBe(false)
        }
        await Bun.sleep(10)
        expect(fetchedUrls).toEqual([])

        // 2. Navigating to /ar syncs dir="rtl", does NOT inject kay-island inline <style>, and does NOT trigger full reload
        await spaClient.navigate('http://localhost/ar', true)
        expect(document.documentElement.getAttribute('lang')).toBe('ar')
        expect(document.documentElement.getAttribute('dir')).toBe('rtl')
        expect(assignedUrls).toEqual([])
        const headStyles = [...document.head.querySelectorAll('style')].map(s => s.textContent)
        expect(headStyles).not.toContain('kay-island,kay-slot{display:contents}')

        // 3. Navigating back to /en (no dir attribute) removes stale dir="rtl"
        await spaClient.navigate('http://localhost/en', true)
        expect(document.documentElement.getAttribute('lang')).toBe('en')
        expect(document.documentElement.getAttribute('dir')).toBeNull()

        // 4. Destination page with a brand-new inline <style> under strict CSP falls back cleanly instead of injecting blocked <style>
        await spaClient.navigate('http://localhost/styled', true)
        expect(assignedUrls).toContain('http://localhost/styled')

        await spaClient.navigate('http://localhost/styled', false)
        expect(reloadCount).toBe(1)
      }
      finally {
        globalThis.fetch = origFetch
        await GlobalRegistrator.unregister()
      }
    })

    it('coordinates spa() + regions() popstate without collisions, records post-redirect URLs, and resists form.action DOM clobbering', async () => {
      GlobalRegistrator.register({ url: 'http://localhost/sets', settings: { handleDisabledFileLoadingAsSuccess: true } })
      const origFetch = globalThis.fetch
      const calls: Array<{ url: string, spa: string | null, region: string | null }> = []
      try {
        document.head.innerHTML = '<title>Sets</title>'
        document.body.innerHTML = [
          '<main id="sets-page">',
          '<a id="filter" href="/old-filter?q=a" data-kay-target="results">Filter</a>',
          '<a id="to-about" href="/about">About</a>',
          '<form id="clobbered" action="/sets" method="get" data-kay-target="results">',
          '<input name="action" value="do-search" />',
          '<input name="method" value="post" />',
          '<input name="q" value="clobber" />',
          '</form>',
          '<div data-kay-region="results" id="results">initial</div>',
          '</main>',
        ].join('')

        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const hdrs = new Headers(init?.headers)
          calls.push({ url, spa: hdrs.get('x-kay-spa'), region: hdrs.get('x-kay-region') })

          if (hdrs.get('x-kay-region') === 'results') {
            if (url.includes('/old-filter')) {
              const res = new Response('<p>redirected-results</p>', {
                status: 200,
                headers: { 'content-type': 'text/html', 'x-kay-region': 'results' },
              })
              Object.defineProperty(res, 'url', { value: 'http://localhost/sets?q=a' })
              return res
            }
            const parsed = new URL(url)
            const q = parsed.searchParams.get('q') ?? 'none'
            const res = new Response(`<p>results:${q}</p>`, {
              status: 200,
              headers: { 'content-type': 'text/html', 'x-kay-region': 'results' },
            })
            Object.defineProperty(res, 'url', { value: url })
            return res
          }

          if (url.startsWith('http://localhost/about')) {
            const res = new Response('<!DOCTYPE html><html><head><title>About</title></head><body><main id="about-page"><h1>About</h1></main></body></html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            })
            Object.defineProperty(res, 'url', { value: url })
            return res
          }

          const parsed = new URL(url)
          const q = parsed.searchParams.get('q') ?? 'initial'
          const res = new Response(
            `<!DOCTYPE html><html><head><title>Sets ${q}</title></head><body><main id="sets-page"><div data-kay-region="results" id="results">${q}</div></main></body></html>`,
            { status: 200, headers: { 'content-type': 'text/html' } },
          )
          Object.defineProperty(res, 'url', { value: url })
          return res
        }) as typeof fetch

        const q = `?auditHist=${Date.now()}`
        const spaMod = await import(`../../plugin-spa/src/client.ts${q}`)
        await import(`../../plugin-spa/src/regions.ts${q}`)

        // 1. Region link whose server response redirects records the post-redirect URL (/sets?q=a, not /old-filter?q=a)
        document.getElementById('filter')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
        await Bun.sleep(20)
        expect(location.pathname + location.search).toBe('/sets?q=a')
        expect(document.getElementById('results')?.innerHTML).toBe('<p>redirected-results</p>')
        const regionEntryState = history.state as Record<string, unknown>

        // 2. DOM-clobbered form (<input name="action"> + <input name="method">) still resolves action="/sets" and method="get"
        const clobberedForm = document.getElementById('clobbered') as HTMLFormElement
        clobberedForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await Bun.sleep(20)
        expect(location.pathname).toBe('/sets')
        expect(location.search).toContain('q=clobber')
        expect(location.search).toContain('action=do-search')
        expect(document.getElementById('results')?.innerHTML).toBe('<p>results:clobber</p>')

        // 3. SPA navigate to /about (new __kayDoc), then popstate back to the earlier document's region entry
        const initialSetsState = { __kayDoc: regionEntryState.__kayDoc, __kayIdx: 0 }
        await spaMod.navigate('http://localhost/about', true)
        expect(document.getElementById('about-page')).not.toBeNull()
        const aboutState = history.state as Record<string, unknown>
        expect(aboutState.__kayDoc).not.toBe(regionEntryState.__kayDoc)

        // Simulate popstate back to /sets (initial entry with __kayIdx: 0 and NO __kayRegion) from /about:
        // Previously BOTH spa() and regions() ignored this entry!
        calls.length = 0
        history.replaceState(initialSetsState, '', '/sets')
        window.dispatchEvent(new PopStateEvent('popstate', { state: initialSetsState }))
        await Bun.sleep(25)
        expect(document.getElementById('sets-page')).not.toBeNull()
        expect(calls.some(c => c.spa === '1' && c.url === 'http://localhost/sets')).toBe(true)
        expect(calls.some(c => c.region !== null)).toBe(false)

        // Now simulate same-document popstate forward to /sets?q=a (same __kayDoc as /sets!):
        // Must be handled by regions() alone, NOT spa()!
        calls.length = 0
        history.replaceState(regionEntryState, '', '/sets?q=a')
        window.dispatchEvent(new PopStateEvent('popstate', { state: regionEntryState }))
        await Bun.sleep(25)
        expect(calls.some(c => c.region === 'results')).toBe(true)
        expect(calls.some(c => c.spa === '1')).toBe(false)
        expect(document.getElementById('results')?.innerHTML).toBe('<p>results:a</p>')
      }
      finally {
        globalThis.fetch = origFetch
        await GlobalRegistrator.unregister()
      }
    })
  })

  describe('2. @kayjs/seo — conditional meta, no canonical on 404/error, sitemap filtering, multi-size favicons, i18n redirects', () => {
    it('avoids duplicate description/og:image, omits canonical on _404/_error, excludes API & /404 from sitemap, preserves multi-size PNG favicons, and reconciles i18n redirects', async () => {
      const dir = makeTemp('kay-seo-audit-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/assets/a'), { recursive: true })
      mkdirSync(join(dir, 'src/assets/b'), { recursive: true })

      writeFileSync(join(dir, 'src/assets/icon-16.png'), makePng(16, 16))
      writeFileSync(join(dir, 'src/assets/icon-32.png'), makePng(32, 32))
      // Colliding basename in two directories
      writeFileSync(join(dir, 'src/assets/a/dup.png'), makePng(48, 48))
      writeFileSync(join(dir, 'src/assets/b/dup.png'), makePng(64, 64))

      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { Head } from '@kayjs/kay'
        export default function Home() {
          return <><Head><title>Home</title></Head><h1>Home</h1></>
        }
      `)
      writeFileSync(join(dir, 'src/routes/custom.tsx'), `
        import { Head } from '@kayjs/kay'
        export default function Custom() {
          return (
            <>
              <Head>
                <title>Custom</title>
                <meta name="description" content="Page-specific description" />
                <meta property="og:image" content="https://example.test/custom-og.png" />
              </Head>
              <h1>Custom</h1>
            </>
          )
        }
      `)
      writeFileSync(join(dir, 'src/routes/ancien.tsx'), `
        export default function Ancien() { return <h1>English Ancien Page</h1> }
      `)
      writeFileSync(join(dir, 'src/routes/missing-item.tsx'), `
        import { notFound } from '@kayjs/kay/server'
        export function load() { return notFound() }
        export default function MissingItem() { return <p>Never</p> }
      `)
      writeFileSync(join(dir, 'src/routes/boom.tsx'), `
        export default function Boom(): never { throw new Error('boom') }
      `)
      writeFileSync(join(dir, 'src/routes/health.ts'), `
        export function GET() { return new Response('ok') }
      `)
      writeFileSync(join(dir, 'src/routes/webhook.ts'), `
        export function POST() { return new Response('received') }
      `)
      writeFileSync(join(dir, 'src/routes/404.tsx'), `
        export default function Explicit404() { return <h1>404 route</h1> }
      `)
      writeFileSync(join(dir, 'src/routes/_404.tsx'), `
        import { Head } from '@kayjs/kay'
        export default function NotFound() { return <><Head><title>Not Found</title></Head><h1>404</h1></> }
      `)
      writeFileSync(join(dir, 'src/routes/_error.tsx'), `
        import { Head } from '@kayjs/kay'
        export default function Err() { return <><Head><title>Error</title></Head><h1>500</h1></> }
      `)

      const plugins = [
        seo({
          site: 'https://example.test',
          name: 'Demo',
          description: 'Default site desc',
          image: '/default-og.png',
          imageAlt: 'Default alt',
          favicon: [
            'src/assets/icon-16.png',
            'src/assets/icon-32.png',
            'src/assets/a/dup.png',
            'src/assets/b/dup.png',
          ],
          redirects: {
            '/old-services': '/custom?ref=old#top',
            '/external': 'https://other.example/landing',
            '/pin-en': '/en/custom',
            '/fr/ancien': '/fr/custom',
          },
        }),
        i18n({
          locales: ['en', 'fr'],
          defaultLocale: 'en',
          site: 'https://example.test',
        }),
      ]

      const manifest = await build({ root: dir, plugins })
      const app = await createServer({ root: dir, plugins })

      // 1. Multi-size PNG favicons emitted to distinct filenames (never overwritten onto favicon.png)
      expect(manifest.publicFiles).toContain('icon-16.png')
      expect(manifest.publicFiles).toContain('icon-32.png')
      expect(manifest.publicFiles).toContain('dup.png')
      expect(manifest.publicFiles).toContain('dup-64x64.png')

      // 2. Default page gets fallback description + og:image + canonical + sized favicon links
      const homeHtml = await (await app.handle(new Request('http://localhost/'))).text()
      expect(homeHtml).toContain('<meta name="description" content="Default site desc">')
      expect(homeHtml).toContain('<meta property="og:image" content="https://example.test/default-og.png">')
      expect(homeHtml).toContain('<link rel="canonical" href="https://example.test/">')
      expect(homeHtml).toContain('<link rel="icon" href="/icon-16.png" type="image/png" sizes="16x16">')
      expect(homeHtml).toContain('<link rel="icon" href="/icon-32.png" type="image/png" sizes="32x32">')

      // 3. Page with its own <Head> description/og:image emits NO duplicates
      const customHtml = await (await app.handle(new Request('http://localhost/custom'))).text()
      expect(customHtml.match(/name="description"/g)).toHaveLength(1)
      expect(customHtml).toContain('content="Page-specific description"')
      expect(customHtml).not.toContain('Default site desc')
      expect(customHtml.match(/property="og:image"/g)).toHaveLength(1)
      expect(customHtml).toContain('content="https://example.test/custom-og.png"')
      expect(customHtml).not.toContain('/default-og.png')

      // 4. _404 (unmatched URL & load()->notFound()) and _error omit <link rel="canonical">
      const notFoundRes = await app.handle(new Request('http://localhost/does-not-exist'))
      expect(notFoundRes.status).toBe(404)
      expect(await notFoundRes.text()).not.toContain('rel="canonical"')

      const loadNotFoundRes = await app.handle(new Request('http://localhost/missing-item'))
      expect(loadNotFoundRes.status).toBe(404)
      expect(await loadNotFoundRes.text()).not.toContain('rel="canonical"')

      const errRes = await app.handle(new Request('http://localhost/boom'))
      expect(errRes.status).toBe(500)
      expect(await errRes.text()).not.toContain('rel="canonical"')

      // 5. sitemap.xml excludes non-page API routes (/health, /webhook) and /404
      const sitemap = readFileSync(join(dir, 'dist/public/sitemap.xml'), 'utf8')
      expect(sitemap).toContain('<loc>https://example.test/</loc>')
      expect(sitemap).toContain('<loc>https://example.test/fr/custom</loc>')
      expect(sitemap).not.toContain('/health')
      expect(sitemap).not.toContain('/webhook')
      expect(sitemap).not.toContain('/404')

      // 6. i18n-reconciled redirects
      const enRedir = await app.handle(new Request('http://localhost/old-services'))
      expect(enRedir.status).toBe(301)
      expect(enRedir.headers.get('location')).toBe('/custom?ref=old#top')

      const frRedir = await app.handle(new Request('http://localhost/fr/old-services'))
      expect(frRedir.status).toBe(301)
      expect(frRedir.headers.get('location')).toBe('/fr/custom?ref=old#top')

      const extRedir = await app.handle(new Request('http://localhost/fr/external'))
      expect(extRedir.headers.get('location')).toBe('https://other.example/landing')

      const pinRedir = await app.handle(new Request('http://localhost/fr/pin-en'))
      expect(pinRedir.headers.get('location')).toBe('/en/custom')

      // Exact locale-prefixed redirect works AND does not shadow the English /ancien page
      const frExact = await app.handle(new Request('http://localhost/fr/ancien'))
      expect(frExact.status).toBe(301)
      expect(frExact.headers.get('location')).toBe('/fr/custom')

      const enAncien = await app.handle(new Request('http://localhost/ancien'))
      expect(enAncien.status).toBe(200)
      expect(await enAncien.text()).toContain('English Ancien Page')
    })

    function seoApp(): string {
      const dir = makeTemp('kay-seo-image-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), `export default function Home() { return <h1>Home</h1> }`)
      return dir
    }

    it('prefixes a relative og:image with the site, even one whose name starts with http, and keeps an absolute or protocol-relative one', async () => {
      const ogImage = async (image: string): Promise<string | undefined> => {
        const app = await testApp({ root: seoApp(), plugins: [seo({ site: 'https://example.test', image })] })
        try {
          return /<meta property="og:image" content="([^"]*)">/.exec(await (await app.fetch('/')).text())?.[1]
        }
        finally {
          await app.app.dispose?.()
        }
      }
      expect(await ogImage('httpfoo.png')).toBe('https://example.test/httpfoo.png')
      expect(await ogImage('https://cdn.example/og.png')).toBe('https://cdn.example/og.png')
      expect(await ogImage('//cdn.example/og.png')).toBe('//cdn.example/og.png')
    })

    it('fails the build on a favicon path that resolves to no file', async () => {
      await expect(build({ root: seoApp(), plugins: [seo({ favicon: 'src/assets/missing.png' })] })).rejects.toThrow('@kayjs/seo: favicon "src/assets/missing.png" is neither a file under the app root nor a package file: fix the path given to `seo({ favicon })`.')
    })
  })

  describe('3. @kayjs/tailwind + @kayjs/ui cascade layer order', () => {
    it('loads @layer kui before Tailwind @layer utilities regardless of plugin declaration order', async () => {
      const orderA = resolvePlugins([tailwind({ css: 'src/app.css', bunPlugin: { name: 'noop', setup() {} } }), ui()])
      const orderB = resolvePlugins([ui(), tailwind({ css: 'src/app.css', bunPlugin: { name: 'noop', setup() {} } })])
      expect(orderA.map(p => p.name)).toEqual(['@kayjs/ui', '@kayjs/tailwind'])
      expect(orderB.map(p => p.name)).toEqual(['@kayjs/ui', '@kayjs/tailwind'])

      const dir = makeTemp('kay-tw-ui-order-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/app.css'), '@layer utilities { .bg-red { background: red; } }\n')
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <button data-ui="button" class="bg-red">Go</button> }\n')

      const noopTw = { name: 'noop-tw', setup() {} }
      const app = await testApp({
        root: dir,
        // Intentionally reversed: tailwind() declared before ui()
        plugins: [tailwind({ css: 'src/app.css', bunPlugin: noopTw }), ui({ grammar: 'editorial' })],
      })
      const html = await (await app.get('/')).text()
      const layerIdx = html.indexOf('<style>@layer properties,theme,base,kui,components,utilities;</style>')
      const uiLinkIdx = html.search(/<link rel="stylesheet" href="\/_kay\/editorial-[^"]+\.css">/)
      const twLinkIdx = html.search(/<link rel="stylesheet" href="\/_kay\/app-[^"]+\.css">/)

      expect(layerIdx).toBeGreaterThan(-1)
      expect(uiLinkIdx).toBeGreaterThan(layerIdx)
      expect(twLinkIdx).toBeGreaterThan(uiLinkIdx)
    })
  })

  describe('4. @kayjs/content + @kayjs/images', () => {
    it('orders @kayjs/content after @kayjs/images regardless of declaration order', () => {
      const sorted = resolvePlugins([content(), images()])
      expect(sorted.map(p => p.name)).toEqual(['@kayjs/images', '@kayjs/content'])
    })

    it('sanitizes Markdown with a strict attribute allowlist blocking data-kay-* and DOM clobbering', () => {
      const dirty = [
        '<div data-kay-target="pane" data-kay-region="evil" data-kay-md-slot="forged-0" data-persist="p" data-ui="button" id="location" name="action" class="prose" title="Safe">',
        '<a href="https://example.com" rel="noopener" data-kay-prefetch data-no-spa id="createElement" name="body" onclick="alert(1)">Link</a>',
        '<img src="/pic.png" alt="Pic" width="100" height="50" name="forms" style="color:red">',
        '</div>',
      ].join('')
      const clean = sanitizeMarkdownHtml(dirty)
      expect(clean).not.toContain('data-kay-')
      expect(clean).not.toContain('data-persist')
      expect(clean).not.toContain('data-ui')
      expect(clean).not.toContain('data-no-spa')
      expect(clean).not.toContain(' id=')
      expect(clean).not.toContain(' name=')
      expect(clean).not.toContain('style=')
      expect(clean).not.toContain('onclick')
      // Safe attributes preserved
      expect(clean).toContain('class="prose"')
      expect(clean).toContain('title="Safe"')
      expect(clean).toContain('href="https://example.com"')
      expect(clean).toContain('rel="noopener"')
      expect(clean).toContain('src="/pic.png"')
      expect(clean).toContain('alt="Pic"')
      expect(clean).toContain('width="100"')
    })

    it('prevents nested <a> in headingLinks and skips inline backtick MDX component expansion', () => {
      let badgeCalls = 0
      const md = [
        '## Plain Heading',
        '',
        '## Heading with [a link](https://example.com)',
        '',
        'Inline `<Badge label="inline" />` and double ``<Badge label="double" />`` must stay code.',
        '',
        '<Note>',
        'Close with `</Note>` and use `<Badge label="inside-note" />` literally.',
        '</Note>',
        '',
        '<Badge label="real" />',
      ].join('\n')

      const rendered = renderMarkdown(md, {
        headingLinks: true,
        components: {
          Badge: ({ label }: { label: string }) => {
            badgeCalls++
            return `<span data-badge="${label}">${label}</span>`
          },
          Note: ({ children }: { children: { __html: string } }) => `<aside>${children.__html}</aside>`,
        },
      })

      expect(rendered.html).toContain('<h2 id="plain-heading"><a href="#plain-heading">Plain Heading</a></h2>')
      expect(rendered.html).toContain('<h2 id="heading-with-a-link">Heading with <a href="https://example.com">a link</a></h2>')
      expect(rendered.html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?<a\b/i)
      expect(badgeCalls).toBe(1)
      expect(rendered.html).toContain('<span data-badge="real">real</span>')
      expect(rendered.html).toContain('<code>&lt;Badge label=&quot;inline&quot; /&gt;</code>')
      expect(rendered.html).toContain('<code>&lt;Badge label=&quot;double&quot; /&gt;</code>')
      expect(rendered.html).toContain('<aside><p>Close with <code>&lt;/Note&gt;</code> and use <code>&lt;Badge label=&quot;inside-note&quot; /&gt;</code> literally.</p></aside>')
    })

    it('handles invalid RSS dates gracefully without emitting Invalid Date', () => {
      const dir = makeTemp('kay-rss-invalid-date-')
      writeFileSync(join(dir, 'good.md'), '---\ntitle: Good\ndate: 2026-05-01\n---\nOk\n')
      writeFileSync(join(dir, 'bad.md'), '---\ntitle: Bad\ndate: not-a-real-date\n---\nOops\n')
      const col = defineCollection({ dir })
      const xml = renderRss({
        title: 'Blog',
        description: 'Desc',
        site: 'https://example.test',
        collection: col,
      })
      expect(xml).toContain('<title>Good</title>')
      expect(xml).toContain('<pubDate>Fri, 01 May 2026 00:00:00 GMT</pubDate>')
      expect(xml).toContain('<title>Bad</title>')
      expect(xml).not.toContain('Invalid Date')
      expect(xml.match(/<pubDate>/g)).toHaveLength(1)
    })

    it('replaces registeredCollections on reload, isolates roots in watchPaths, and discovers collections in src/routes/*.tsx', async () => {
      const dirA = makeTemp('kay-col-root-a-')
      const dirB = makeTemp('kay-col-root-b-')
      mkdirSync(join(dirA, 'src/routes/blog'), { recursive: true })
      mkdirSync(join(dirA, 'content/posts'), { recursive: true })
      mkdirSync(join(dirA, 'node_modules/@kayjs'), { recursive: true })
      symlinkSync(join(import.meta.dir, '..'), join(dirA, 'node_modules/@kayjs/kay'), 'dir')
      writeFileSync(join(dirA, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { jsx: 'react-jsx', jsxImportSource: '@kayjs/kay' },
      }))
      mkdirSync(join(dirB, 'src/routes'), { recursive: true })
      mkdirSync(join(dirB, 'content/posts'), { recursive: true })

      writeFileSync(join(dirA, 'content/posts/bad.md'), '---\ntitle: ""\n---\nHi\n')
      writeFileSync(join(dirA, 'src/routes/blog/index.tsx'), `
        import { defineCollection } from ${JSON.stringify(CONTENT_PKG)}
        const schema = {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate(raw: unknown) {
              const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
              if (typeof o.title !== 'string' || !o.title.trim())
                return { issues: [{ message: 'title required', path: ['title'] }] }
              return { value: { title: o.title } }
            },
          },
        }
        export const blog = defineCollection({ dir: 'content/posts', schema })
        export default function Blog() { return <h1>{blog.all().length}</h1> }
      `)
      writeFileSync(join(dirA, 'kay.config.ts'), `
        import { content } from ${JSON.stringify(CONTENT_PKG)}
        export default { plugins: [content()] }
      `)
      writeFileSync(join(dirB, 'src/routes/index.tsx'), 'export default function Home() { return <h1>B</h1> }\n')

      // 1. discoverAppCollections finds collection defined inside src/routes/blog/index.tsx
      const checked = await checkProject(dirA, { skipTypecheck: true })
      expect(checked.ok).toBe(false)
      expect(checked.errors.some(e => e.includes('content/posts/bad.md') && e.includes('title required'))).toBe(true)

      // 2. watchPaths(dirA) includes dirA/content/posts, and dirA's registered collection does NOT leak into dirB
      const plugin = content()
      const watchFn = plugin.watchPaths as (root: string) => string[]
      expect(watchFn(dirA)).toContain(join(dirA, 'content/posts'))
      expect(watchFn(dirB)).toEqual([])

      // 3. Re-evaluating defineCollection for the same dir replaces the entry instead of leaking
      const sizeBefore = registeredCollections.size
      const absColDir = join(dirA, 'content/posts')
      defineCollection({ dir: absColDir })
      const sizeAfterFirst = registeredCollections.size
      defineCollection({ dir: absColDir })
      defineCollection({ dir: absColDir })
      expect(registeredCollections.size).toBe(sizeAfterFirst)
      expect(registeredCollections.size).toBeLessThanOrEqual(sizeBefore + 1)
    })

    // An app whose route defines a collection over one bad file and renders a JSX component of its own.
    function collectionApp(prefix: string): string {
      const dir = makeTemp(prefix)
      mkdirSync(join(dir, 'src/routes/blog'), { recursive: true })
      mkdirSync(join(dir, 'src/components'), { recursive: true })
      mkdirSync(join(dir, 'content/posts'), { recursive: true })
      mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
      symlinkSync(join(import.meta.dir, '..'), join(dir, 'node_modules/@kayjs/kay'), 'dir')
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: '@kayjs/kay' } }))
      writeFileSync(join(dir, 'content/posts/bad.md'), '---\ntitle: ""\n---\nHi\n')
      writeFileSync(join(dir, 'src/components/Title.tsx'), 'export function Title({ n }: { n: number }) { return <h1>{n}</h1> }\n')
      writeFileSync(join(dir, 'src/routes/blog/index.tsx'), `
        import { defineCollection } from ${JSON.stringify(CONTENT_PKG)}
        import { Title } from '../../components/Title'
        const schema = {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate(raw: unknown) {
              const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
              return typeof o.title === 'string' && o.title.trim() ? { value: { title: o.title } } : { issues: [{ message: 'title required', path: ['title'] }] }
            },
          },
        }
        export const blog = defineCollection({ dir: 'content/posts', schema })
        export default function Blog() { return <Title n={blog.all().length} /> }
      `)
      writeFileSync(join(dir, 'kay.config.ts'), `import { content } from ${JSON.stringify(CONTENT_PKG)}\nexport default { plugins: [content()] }\n`)
      return dir
    }

    it('kay check validates a .tsx route\'s collection run from a folder whose tsconfig names React (#3670)', async () => {
      const app = collectionApp('kay-col-cwd-')
      const elsewhere = makeTemp('kay-col-react-')
      writeFileSync(join(elsewhere, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' } }))
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli/index.ts'), 'check', app, '--no-typecheck'], { cwd: elsewhere, stdout: 'pipe', stderr: 'pipe' })
      const out = await new Response(proc.stdout).text() + await new Response(proc.stderr).text()
      expect(await proc.exited).toBe(1)
      expect(out).toContain('content/posts/bad.md:2:1: error: @kayjs/content: title: title required')
    })

    it('checkProject validates the .tsx collections of two apps in one process (#3670)', async () => {
      for (const app of [collectionApp('kay-col-one-'), collectionApp('kay-col-two-')]) {
        const checked = await checkProject(app, { skipTypecheck: true })
        expect(checked.errors.some(e => e.includes('content/posts/bad.md') && e.includes('title required'))).toBe(true)
      }
    })

    it('avoids Bun.spawnSync in @kayjs/images, blocks shareCard symlink escapes, and serves runtime images without dist/public writes', async () => {
      // 1. Zero Bun.spawnSync in plugin-images/src/
      const imgSrcDir = join(REPO_ROOT, 'packages/plugin-images/src')
      for (const name of readdirSync(imgSrcDir)) {
        if (!name.endsWith('.ts') && !name.endsWith('.tsx'))
          continue
        const src = readFileSync(join(imgSrcDir, name), 'utf8')
        expect(src, name).not.toMatch(/\bBun\.spawnSync\s*\(/)
      }

      // 2. shareCard() rejects symlink escaping project root via realpathSync
      const outer = makeTemp('kay-card-symlink-')
      const projectRoot = join(outer, 'app')
      const outPub = join(outer, 'pub')
      mkdirSync(join(projectRoot, 'src/assets'), { recursive: true })
      writeFileSync(join(outer, 'secret.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>TOP_SECRET_SVG</text></svg>')
      symlinkSync(join(outer, 'secret.svg'), join(projectRoot, 'src/assets/escape.svg'))

      const prevCwd = process.cwd()
      process.chdir(projectRoot)
      try {
        const prevPath = process.env.PATH
        process.env.PATH = ''
        try {
          const cardUrl = shareCard({ title: 'Symlink Test', image: 'src/assets/escape.svg' }, { publicDir: outPub })
          expect(cardUrl).toMatch(/^\/og\/symlink-test-.*\.svg$/)
          const writtenSvg = readFileSync(join(outPub, cardUrl.slice(1)), 'utf8')
          expect(writtenSvg).not.toContain('TOP_SECRET_SVG')
          expect(writtenSvg).not.toContain('<image href=')
        }
        finally {
          process.env.PATH = prevPath
        }
      }
      finally {
        process.chdir(prevCwd)
      }

      // 3. Runtime server serves dynamically generated shareCard() & optimizeImageFile() without writing to dist/public (read-only FS / --compile safe)
      const dir = makeTemp('kay-images-runtime-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'content/posts'), { recursive: true })
      writeFileSync(join(dir, 'content/posts/hero.png'), VALID_1X1_PNG)
      writeFileSync(join(dir, 'content/posts/post.md'), '---\ntitle: Runtime\n---\n![Hero](./hero.png)\n')
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { raw } from '@kayjs/kay/internal/ssr'
        import { defineCollection } from ${JSON.stringify(CONTENT_PKG)}
        import { shareCard } from ${JSON.stringify(IMAGES_PKG)}
        const posts = defineCollection({ dir: 'content/posts' })
        export default function Home() {
          const entry = posts.get('post')!
          const card = shareCard({ title: 'Runtime Card' })
          return <main data-card={card}>{raw(entry.html)}</main>
        }
      `)

      const plugins = [images({ widths: [320], formats: ['webp'] }), content()]
      await build({ root: dir, plugins })

      // Make dist/public read-only (and ensure og/ & img/ do NOT exist) to prove zero runtime writes
      const distPublic = join(dir, 'dist/public')
      mkdirSync(distPublic, { recursive: true })
      chmodSync(distPublic, 0o555)
      try {
        const app = await createServer({ root: dir, plugins })
        const pageRes = await app.handle(new Request('http://localhost/'))
        expect(pageRes.status).toBe(200)
        const html = await pageRes.text()

        const cardMatch = /data-card="(\/og\/[^"]+)"/.exec(html)
        const imgMatch = /src="(\/img\/[^"]+)"/.exec(html)
        expect(cardMatch).not.toBeNull()
        expect(imgMatch).not.toBeNull()

        // Neither file was written into dist/public on disk
        expect(existsSync(join(distPublic, 'og'))).toBe(false)
        expect(existsSync(join(distPublic, 'img'))).toBe(false)

        // Both URLs serve cleanly from the in-memory runtime store with valid image bytes!
        const cardRes = await app.handle(new Request(`http://localhost${cardMatch![1]}`))
        expect(cardRes.status).toBe(200)
        expect(cardRes.headers.get('content-type')).toMatch(/^image\/(?:png|svg\+xml)$/)
        expect((await cardRes.arrayBuffer()).byteLength).toBeGreaterThan(8)

        const imgRes = await app.handle(new Request(`http://localhost${imgMatch![1]}`))
        expect(imgRes.status).toBe(200)
        expect(imgRes.headers.get('content-type')).toMatch(/^image\/(?:webp|png)$/)
        expect((await imgRes.arrayBuffer()).byteLength).toBeGreaterThan(8)
      }
      finally {
        chmodSync(distPublic, 0o755)
      }

      // 4. Direct optimizeImageFile still works standalone without spawning synchronously
      const standalonePub = makeTemp('kay-img-standalone-')
      const asset = optimizeImageFile(join(dir, 'content/posts/hero.png'), { outPublicDir: standalonePub })
      expect(asset.width).toBe(1)
      expect(asset.height).toBe(1)
      expect(existsSync(join(standalonePub, asset.src.slice(1)))).toBe(true)
    })
  })
})

describe('@kayjs/images encodes under one build-wide budget (#3655)', () => {
  it('runs at most ENCODE_SLOTS magick at once over 20 images, bounds each one, and reports a failed encode', async () => {
    const dir = makeTemp('kay-image-slots-')
    const bin = join(dir, 'bin')
    const runs = join(dir, 'runs')
    mkdirSync(bin)
    mkdirSync(runs)
    writeFileSync(join(bin, 'magick'), `#!/bin/sh
mkdir "${runs}/run.$$"
ls -d "${runs}"/run.* | wc -l >> "${runs}/counts"
echo "$*" >> "${runs}/args"
sleep 0.05
rmdir "${runs}/run.$$"
case "$*" in *identify*) printf '64 48'; exit 0;; esac
case "$*" in *bad*) echo "fake magick: bad input" >&2; exit 1;; esac
prev=; for arg; do [ "$prev" = -write ] && [ "\${arg#mpr:}" = "$arg" ] && printf 'x' > "$arg"; prev=$arg; done
`)
    chmodSync(join(bin, 'magick'), 0o755)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/assets'), { recursive: true })
    const names = [...Array.from({ length: 19 }, (_, i) => `i${i}`), 'bad']
    for (const name of names)
      writeFileSync(join(dir, `src/assets/${name}.png`), makePng(64, 48))
    writeFileSync(join(dir, 'kay.config.ts'), `import { images } from '${IMAGES_PKG}'\nexport default { plugins: [images({ widths: [16, 32] })], compliance: { legalNotice: false } }\n`)
    writeFileSync(join(dir, 'src/routes/index.tsx'), [
      ...names.map(name => `import ${name} from '../assets/${name}.png'`),
      `export default function Home() { return <main>{[${names.join(', ')}].map(img => <img src={img.src} alt="" />)}</main> }`,
    ].join('\n'))

    const prevPath = process.env.PATH
    process.env.PATH = `${bin}:${prevPath}`
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    let warned: string[] = []
    try {
      await build({ root: dir })
      warned = warn.mock.calls.map(call => String(call[0]))
    }
    finally {
      process.env.PATH = prevPath
      warn.mockRestore()
    }

    const counts = readFileSync(join(runs, 'counts'), 'utf8').trim().split('\n').map(Number)
    expect(Math.max(...counts)).toBeLessThanOrEqual(ENCODE_SLOTS)
    const args = readFileSync(join(runs, 'args'), 'utf8').trim().split('\n')
    for (const line of args)
      expect(line).toContain('-limit thread 1 -limit memory 512MiB -limit map 1GiB')
    // One decode per image and format (#3677): 20 images in avif and webp, and no identify, the PNG header giving the size.
    expect(args.length).toBe(40)
    expect(args.filter(line => line.includes('identify'))).toEqual([])
    expect(args.filter(line => line.includes('/i0.png[0]') && line.endsWith('null:')).length).toBe(2)
    expect(warned.some(message => message.includes('src/assets/bad.png') && message.includes('fake magick: bad input'))).toBe(true)
  })
})

describe('@kayjs/images decodes each image once per format (#3677)', () => {
  function app(dir: string, name: string, config: string) {
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'kay.config.ts'), `import { images } from '${IMAGES_PKG}'\nexport default { plugins: [images(${config})], compliance: { legalNotice: false } }\n`)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `import { image } from '${IMAGES_PKG}'\nimport photo from '../assets/${name}'\nexport default function Home() { return <img {...image(photo, { sizes: '100vw' })} alt="" /> }\n`)
  }

  it('writes the same bytes as one magick run per variant', async () => {
    const dir = makeTemp('kay-image-decode-once-')
    mkdirSync(join(dir, 'src/assets'), { recursive: true })
    const src = join(dir, 'src/assets/photo.png')
    expect(Bun.spawnSync(['magick', '-size', '400x300', '-seed', '7', 'plasma:', src]).exitCode).toBe(0)
    app(dir, 'photo.png', `{ widths: [160, 320], formats: ['avif', 'webp'], quality: 80, avifQuality: 55, cacheDir: '.cache' }`)
    await build({ root: dir })

    const cached = readdirSync(join(dir, '.cache')).filter(file => /-\d+w\.(?:avif|webp)$/.test(file)).sort()
    expect(cached.map(file => file.replace(/^photo-[^-]+-/, ''))).toEqual(['160w.avif', '160w.webp', '320w.avif', '320w.webp', '400w.avif', '400w.webp'])
    for (const file of cached) {
      const [, width, format] = /-(\d+)w\.(avif|webp)$/.exec(file)!
      const alone = join(dir, `alone.${format}`)
      const run = Bun.spawnSync(['magick', '-limit', 'thread', '1', `${src}[0]`, '-auto-orient', '-strip', '-resize', `${width}x>`, '-quality', format === 'avif' ? '55' : '80', alone])
      expect(run.exitCode).toBe(0)
      expect(Bun.hash(readFileSync(join(dir, '.cache', file)))).toBe(Bun.hash(readFileSync(alone)))
    }
  })

  it('keeps the variants a failed run finished, drops the one it was writing, and names the widths left out', async () => {
    const dir = makeTemp('kay-image-part-')
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    // Writes the first two webp targets, the second one cut short, then fails.
    writeFileSync(join(bin, 'magick'), `#!/bin/sh
n=0; prev=; for arg; do
  if [ "$prev" = -write ] && [ "\${arg#mpr:}" = "$arg" ]; then
    case "$arg" in *.webp) n=$((n+1)); printf 'x' > "$arg"; [ $n = 2 ] && { echo "fake magick: disk full" >&2; exit 1; };; *) printf 'x' > "$arg";; esac
  fi
  prev=$arg
done
`)
    chmodSync(join(bin, 'magick'), 0o755)
    mkdirSync(join(dir, 'src/assets'), { recursive: true })
    writeFileSync(join(dir, 'src/assets/part.png'), makePng(64, 48))
    app(dir, 'part.png', `{ widths: [16, 32], formats: ['avif', 'webp'] }`)

    const prevPath = process.env.PATH
    process.env.PATH = `${bin}:${prevPath}`
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    let warned: string[] = []
    try {
      await build({ root: dir })
      warned = warn.mock.calls.map(call => String(call[0]))
    }
    finally {
      process.env.PATH = prevPath
      warn.mockRestore()
    }
    const app2 = await createServer({ root: dir })
    const html = await (await app2.handle(new Request('http://localhost/'))).text()
    const webp = /srcset="([^"]*\.webp[^"]*)"/.exec(html)?.[1] ?? ''
    expect(webp.split(', ').map(entry => entry.split(' ')[1])).toEqual(['16w'])
    const cached = readdirSync(join(dir, '.kay-cache/images')).filter(file => /w\.(?:avif|webp)$/.test(file)).map(file => file.replace(/^part-[^-]+-/, '')).sort()
    expect(cached).toEqual(['16w.avif', '16w.webp', '32w.avif', '64w.avif'])
    expect(warned.some(message => message.includes('part.png at 32w, 64w (webp)') && message.includes('fake magick: disk full'))).toBe(true)

    // The next build, with a working magick, encodes only the two webp widths left out.
    writeFileSync(join(bin, 'magick'), `#!/bin/sh
echo "$*" >> "${dir}/args"
prev=; for arg; do [ "$prev" = -write ] && [ "\${arg#mpr:}" = "$arg" ] && printf 'x' > "$arg"; prev=$arg; done
`)
    process.env.PATH = `${bin}:${prevPath}`
    try {
      await build({ root: dir })
    }
    finally {
      process.env.PATH = prevPath
    }
    const rerun = readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')
    expect(rerun.length).toBe(1)
    expect(rerun[0]!.match(/-\d+w\.[a-z]+/g)?.map(target => target.replace(/\.tmp.*$/, ''))).toEqual(['-32w', '-64w'])
  })
})
