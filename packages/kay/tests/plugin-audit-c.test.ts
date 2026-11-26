import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { i18n } from '../../plugin-i18n/src/index'
import { build } from '../src/build/index'
import { definePlugin } from '../src/plugins/index'
import { createHtmlHeaders, withPluginHtmlCsp } from '../src/server/document'
import { buildSecurityHeaderEntries } from '../src/server/security'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function appWith(prefix: string, files: Record<string, string>): string {
  const dir = makeTemp(prefix)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('Cross-plugin audit part 3 (#3635): @kayjs/i18n & plugin host safety', () => {
  describe('@kayjs/i18n actions, public/, regions, escaping, assetPrefix & prefixDefault', () => {
    it('populates ctx.locals.locale and t before Server Actions, serves localized public/ links, and runs transformHtml on <Region> without double-escaping &amp;', async () => {
      const dir = appWith('kay-i18n-audit-', {
        'public/brochure.txt': 'SHARED BROCHURE',
        'public/guide.txt': 'DEFAULT GUIDE',
        'public/fr/guide.txt': 'GUIDE FR',
        'src/routes/index.tsx': `
          import { Region } from '@kayjs/kay'
          import { action } from '@kayjs/kay/server'

          export const greet = action(async (ctx) => ({
            locale: ctx.locals.locale ?? 'missing',
            hello: ctx.locals.t ? ctx.locals.t('hello') : 'no-t',
          }))

          export default function Home({ locals }: { locals: { locale?: string, t?: (k: string) => string } }) {
            return (
              <main>
                <h1>{locals.t ? locals.t('hello') : 'none'}</h1>
                <a href="/search?a=1&b=2">Search</a>
                <a href="/fr?page=2">Already FR</a>
                <a href="/fr#top">FR Hash</a>
                <a href="/assets/custom.js">Custom Asset</a>
                <form action={greet} method="post"><button type="submit">Go</button></form>
                <Region name="results">
                  <nav>
                    <a href="/items/42">Item 42</a>
                    <a href="/search?q=kay&sort=asc">Filtered</a>
                  </nav>
                </Region>
              </main>
            )
          }
        `,
        'src/routes/items/[id].tsx': `
          export default function Item({ params }: { params: { id: string } }) {
            return <p>Item {params.id}</p>
          }
        `,
      })

      const app = await testApp({
        root: dir,
        assetPrefix: '/assets',
        plugins: [
          i18n({
            locales: ['en', 'fr'],
            defaultLocale: 'en',
            messages: {
              en: { hello: 'Hello' },
              fr: { hello: 'Bonjour' },
            },
          }),
        ],
      })

      // 1. Escaping & custom assetPrefix in transformHtml
      const frRes = await app.get('/fr')
      expect(frRes.status).toBe(200)
      const frHtml = await frRes.text()
      expect(frHtml).toContain('<h1>Bonjour</h1>')
      // Query string &amp; must NOT be double-escaped into &amp;amp;
      expect(frHtml).toContain('href="/fr/search?a=1&amp;b=2"')
      expect(frHtml).not.toContain('&amp;amp;')
      // Already-prefixed query/hash links must NOT be double-prefixed
      expect(frHtml).toContain('href="/fr?page=2"')
      expect(frHtml).toContain('href="/fr#top"')
      // Custom assetPrefix is respected instead of hardcoded /_kay/
      expect(frHtml).toContain('href="/assets/custom.js"')

      // 2. <Region> responses run transformHtml so swapped links stay localized without double-escaping
      const regionRes = await app.get('/fr', { 'x-kay-region': 'results' })
      expect(regionRes.status).toBe(200)
      const regionHtml = await regionRes.text()
      expect(regionHtml).toContain('href="/fr/items/42"')
      expect(regionHtml).toContain('href="/fr/search?q=kay&amp;sort=asc"')
      expect(regionHtml).not.toContain('&amp;amp;')

      // 3. Server Actions get ctx.locals.locale / t (from Referer, prefixed URL, or defaultLocale)
      const actionUrl = app.manifest!.actions[0]!.url
      expect(actionUrl.startsWith('/assets/action/')).toBe(true)

      const frAction = await app.fetch(actionUrl, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'referer': 'http://localhost/fr',
        },
        body: '{}',
      })
      expect(frAction.status).toBe(200)
      expect(await frAction.json()).toEqual({ ok: true, data: { locale: 'fr', hello: 'Bonjour' } })

      const defaultAction = await app.fetch(actionUrl, {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        body: '{}',
      })
      expect(defaultAction.status).toBe(200)
      expect(await defaultAction.json()).toEqual({ ok: true, data: { locale: 'en', hello: 'Hello' } })

      // Untrusted Referer origin is ignored and falls back to defaultLocale
      const untrustedRefAction = await app.fetch(actionUrl, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'referer': 'https://evil.example/fr/spoof',
        },
        body: '{}',
      })
      expect(untrustedRefAction.status).toBe(200)
      expect(await untrustedRefAction.json()).toEqual({ ok: true, data: { locale: 'en', hello: 'Hello' } })

      // Explicitly prefixed action path also resolves locale and executes the action
      const prefixedAction = await app.fetch(`/fr${actionUrl}`, {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        body: '{}',
      })
      expect(prefixedAction.status).toBe(200)
      expect(await prefixedAction.json()).toEqual({ ok: true, data: { locale: 'fr', hello: 'Bonjour' } })

      // 4. Localized public/ links fall back to public/ after rewrite while locale-specific files still take precedence
      expect(await (await app.get('/brochure.txt')).text()).toBe('SHARED BROCHURE')
      const frBrochure = await app.get('/fr/brochure.txt')
      expect(frBrochure.status).toBe(200)
      expect(await frBrochure.text()).toBe('SHARED BROCHURE')

      expect(await (await app.get('/guide.txt')).text()).toBe('DEFAULT GUIDE')
      expect(await (await app.get('/fr/guide.txt')).text()).toBe('GUIDE FR')
    })

    it('redirects unprefixed page URLs when prefixDefault is true without breaking assets, actions, API routes, or public files', async () => {
      const dir = appWith('kay-i18n-prefix-default-', {
        'public/logo.txt': 'LOGO',
        'src/styles/app.css': 'body { color: #111; }',
        'src/routes/index.tsx': `
          import '../styles/app.css'
          import { action } from '@kayjs/kay/server'
          export const ping = action(async (ctx) => ({ locale: ctx.locals.locale }))
          export default function Home({ locals }: { locals: { locale?: string } }) {
            return <main><p>Home {locals.locale}</p><a href="/about">About</a></main>
          }
        `,
        'src/routes/about.tsx': `
          export default function About({ locals }: { locals: { locale?: string } }) {
            return <p>About {locals.locale}</p>
          }
        `,
        'src/routes/api/ping.ts': `
          export function GET() {
            return Response.json({ ok: true })
          }
        `,
      })

      const app = await testApp({
        root: dir,
        assetPrefix: '/static',
        plugins: [
          i18n({
            locales: ['en', 'fr'],
            defaultLocale: 'en',
            prefixDefault: true,
          }),
        ],
      })

      // Unprefixed pages redirect 302 to defaultLocale with query string preserved
      const rootRedir = await app.get('/')
      expect(rootRedir.status).toBe(302)
      expect(rootRedir.headers.get('location')).toBe('/en')

      const aboutRedir = await app.get('/about?tab=2&x=1')
      expect(aboutRedir.status).toBe(302)
      expect(aboutRedir.headers.get('location')).toBe('/en/about?tab=2&x=1')

      const headRedir = await app.fetch('/about?tab=2', { method: 'HEAD' })
      expect(headRedir.status).toBe(302)
      expect(headRedir.headers.get('location')).toBe('/en/about?tab=2')

      // Prefixed pages render 200 with localized links
      const enAbout = await app.get('/en/about')
      expect(enAbout.status).toBe(200)
      expect(await enAbout.text()).toContain('About en')

      const frAbout = await app.get('/fr/about')
      expect(frAbout.status).toBe(200)
      expect(await frAbout.text()).toContain('About fr')

      // Public files, client assets, API routes, /_i18n/locales, and Server Actions do NOT redirect
      const pubRes = await app.get('/logo.txt')
      expect(pubRes.status).toBe(200)
      expect(await pubRes.text()).toBe('LOGO')

      const cssAsset = app.manifest!.assets.find(a => a.endsWith('.css'))!
      const assetRes = await app.get(`/static/${cssAsset}`)
      expect(assetRes.status).toBe(200)

      const apiRes = await app.get('/api/ping')
      expect(apiRes.status).toBe(200)
      expect(await apiRes.json()).toEqual({ ok: true })

      const localesRes = await app.get('/_i18n/locales')
      expect(localesRes.status).toBe(200)
      expect(await localesRes.json()).toEqual({ locales: ['en', 'fr'], defaultLocale: 'en', current: 'en' })

      const actionUrl = app.manifest!.actions[0]!.url
      const actRes = await app.fetch(actionUrl, {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json', 'referer': 'http://localhost/en/about' },
        body: '{}',
      })
      expect(actRes.status).toBe(200)
      expect(await actRes.json()).toEqual({ ok: true, data: { locale: 'en' } })
    })
  })

  describe('Plugin host safety', () => {
    it('throws on colliding plugin routes (same method+path or ALL conflict) while allowing distinct methods on the same path', async () => {
      const dir = appWith('kay-route-collision-', {
        'src/routes/index.tsx': `export default function Home() { return <p>ok</p> }`,
      })

      // 1. Same method + path across two plugins fails fast
      const pluginA = definePlugin({
        name: 'plugin-a',
        server(api) {
          api.route('GET', '/shared/hook/', ctx => ctx.text('a'))
        },
      })
      const pluginB = definePlugin({
        name: 'plugin-b',
        server(api) {
          api.route('GET', '/shared/hook', ctx => ctx.text('b'))
        },
      })
      await expect(testApp({ root: dir, plugins: [pluginA, pluginB] })).rejects.toThrow(/kay:.*plugin-b.*GET \/shared\/hook.*plugin-a/)

      // 2. ALL colliding with an existing method (and vice versa) fails fast
      const pluginAll = definePlugin({
        name: 'plugin-all',
        server(api) {
          api.route('ALL', '/shared/hook', ctx => ctx.text('all'))
        },
      })
      await expect(testApp({ root: dir, plugins: [pluginA, pluginAll] })).rejects.toThrow(/kay:.*plugin-all.*ALL \/shared\/hook.*plugin-a/)
      await expect(testApp({ root: dir, plugins: [pluginAll, pluginB] })).rejects.toThrow(/kay:.*plugin-b.*GET \/shared\/hook.*plugin-all/)

      // 3. Different methods on the same path are allowed
      const pluginPost = definePlugin({
        name: 'plugin-post',
        server(api) {
          api.route('POST', '/shared/hook', ctx => ctx.text('post'), { csrf: false })
        },
      })
      const app = await testApp({ root: dir, plugins: [pluginA, pluginPost] })
      expect(await (await app.get('/shared/hook')).text()).toBe('a')
      expect(await (await app.fetch('/shared/hook', { method: 'POST' })).text()).toBe('post')
    })

    it('throws when two distinct plugin instances collide on the same pluginData key while allowing one plugin to merge across build & afterPrerender', async () => {
      const dir = appWith('kay-plugindata-collision-', {
        'src/routes/index.tsx': `export default function Home() { return <p>ok</p> }`,
      })

      const dup1 = definePlugin({
        name: 'shared-name',
        build(ctx) {
          ctx.setData({ a: 1 })
        },
      })
      const dup2 = definePlugin({
        name: 'shared-name',
        build(ctx) {
          ctx.setData({ b: 2 })
        },
      })
      await expect(build({ root: dir, plugins: [dup1, dup2] })).rejects.toThrow(/kay: duplicate pluginData key "shared-name"/)

      // Collision across build() and afterPrerender() from two distinct instances also throws
      const dup3 = definePlugin({
        name: 'shared-name',
        afterPrerender(ctx) {
          ctx.setData({ c: 3 })
        },
      })
      await expect(build({ root: dir, plugins: [dup1, dup3] })).rejects.toThrow(/kay: duplicate pluginData key "shared-name"/)

      // Single plugin merging data across build() and afterPrerender() succeeds cleanly
      const single = definePlugin({
        name: 'single-owner',
        build(ctx) {
          ctx.setData({ step1: true })
        },
        afterPrerender(ctx) {
          ctx.setData({ step2: true })
        },
      })
      const manifest = await build({ root: dir, plugins: [single] })
      expect(manifest.pluginData?.['single-owner']).toEqual({ step1: true, step2: true })
    })

    it('catches throwing transformHtml hooks with source="plugin" on normal pages, streaming Suspense pages, and <Region> responses', async () => {
      const dir = appWith('kay-transform-errors-', {
        'src/routes/index.tsx': `
          import { Region } from '@kayjs/kay'
          export default function Home() {
            return <main><p>Normal</p><Region name="box"><p>Box</p></Region></main>
          }
        `,
        'src/routes/stream.tsx': `
          import { Suspense } from '@kayjs/kay'
          async function Slow() {
            await Bun.sleep(5)
            return <p>Resolved</p>
          }
          export default function Stream() {
            return <Suspense fallback={<p>Loading</p>}><Slow /></Suspense>
          }
        `,
      })

      const broken = definePlugin({
        name: 'broken-transform',
        transformHtml() {
          throw new Error('transform exploded')
        },
      })
      const healthy = definePlugin({
        name: 'healthy-transform',
        transformHtml(html) {
          return `${html}<!--healthy-->`
        },
      })

      const seenErrors: Array<{ source: string, message: string }> = []
      const app = await testApp({
        root: dir,
        plugins: [broken, healthy],
        onError(info) {
          seenErrors.push({ source: info.source, message: (info.error as Error).message })
        },
      })

      // Normal page
      const normalRes = await app.get('/')
      expect(normalRes.status).toBe(200)
      const normalHtml = await normalRes.text()
      expect(normalHtml).toContain('<p>Normal</p>')
      expect(normalHtml).toContain('<!--healthy-->')

      // Streaming Suspense page
      const streamRes = await app.get('/stream')
      expect(streamRes.status).toBe(200)
      const streamHtml = await streamRes.text()
      expect(streamHtml).toContain('<p>Resolved</p>')
      expect(streamHtml).toContain('<!--healthy-->')

      // Region response
      const regionRes = await app.get('/', { 'x-kay-region': 'box' })
      expect(regionRes.status).toBe(200)
      const regionHtml = await regionRes.text()
      expect(regionHtml).toContain('<p>Box</p>')
      expect(regionHtml).toContain('<!--healthy-->')

      expect(seenErrors).toEqual([
        { source: 'plugin', message: 'transform exploded' },
        { source: 'plugin', message: 'transform exploded' },
        { source: 'plugin', message: 'transform exploded' },
      ])
    })

    it('preserves pre-compressed bytes and never buffers open streamed plugin HTML in withPluginHtmlCsp', async () => {
      const securityRecord = Object.fromEntries(buildSecurityHeaderEntries(undefined))
      const htmlHeaders = createHtmlHeaders(undefined, securityRecord)

      // 1. Pre-compressed HTML response must NOT be decoded as UTF-8
      const originalHtml = '<!DOCTYPE html><html><head><style>body{color:green}</style></head><body><p>Gzipped</p></body></html>'
      const gzipped = Bun.gzipSync(new TextEncoder().encode(originalHtml))
      const precompressedRes = new Response(gzipped, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'gzip',
        },
      })
      const wrappedGzip = await withPluginHtmlCsp(precompressedRes, htmlHeaders)
      expect(wrappedGzip.headers.get('content-encoding')).toBe('gzip')
      expect(wrappedGzip.headers.get('content-security-policy')).toContain("default-src 'self'")
      const decompressed = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await wrappedGzip.arrayBuffer())))
      expect(decompressed).toBe(originalHtml)

      // 2. Open streamed HTML must return immediately without waiting for stream close
      let pushSecond!: () => void
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<!DOCTYPE html><body><p>chunk1</p>'))
          pushSecond = () => {
            controller.enqueue(new TextEncoder().encode('<p>chunk2</p></body>'))
            controller.close()
          }
        },
      })
      const streamedRes = new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })

      const t0 = performance.now()
      const wrappedStream = await withPluginHtmlCsp(streamedRes, htmlHeaders)
      expect(performance.now() - t0).toBeLessThan(100)
      expect(wrappedStream.headers.get('content-security-policy')).toContain("default-src 'self'")

      const reader = wrappedStream.body!.getReader()
      const decoder = new TextDecoder()
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(decoder.decode(first.value)).toBe('<!DOCTYPE html><body><p>chunk1</p>')

      pushSecond()
      const second = await reader.read()
      expect(second.done).toBe(false)
      expect(decoder.decode(second.value)).toBe('<p>chunk2</p></body>')
      expect((await reader.read()).done).toBe(true)

      // 3. Explicit transfer-encoding: chunked passes through without buffering
      const chunkedRes = new Response('<p>chunked</p>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'transfer-encoding': 'chunked' },
      })
      const wrappedChunked = await withPluginHtmlCsp(chunkedRes, htmlHeaders)
      expect(wrappedChunked.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(await wrappedChunked.text()).toBe('<p>chunked</p>')

      // 4. End-to-end plugin route serving pre-compressed & streamed HTML through server handle()
      const dir = appWith('kay-plugin-csp-stream-', {
        'src/routes/index.tsx': `export default function Home() { return <p>ok</p> }`,
      })
      let closeRouteStream!: () => void
      const plugin = definePlugin({
        name: 'stream-and-gzip',
        server(api) {
          api.route('GET', '/_plugin/gzip', () => new Response(gzipped, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' },
          }))
          api.route('GET', '/_plugin/stream', () => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('<p>live-1</p>'))
              closeRouteStream = () => {
                controller.enqueue(new TextEncoder().encode('<p>live-2</p>'))
                controller.close()
              }
            },
          }), { headers: { 'content-type': 'text/html; charset=utf-8' } }))
        },
      })
      const app = await testApp({ root: dir, plugins: [plugin] })

      const gzRes = await app.get('/_plugin/gzip', { 'accept-encoding': 'gzip' })
      expect(gzRes.status).toBe(200)
      expect(gzRes.headers.get('content-encoding')).toBe('gzip')
      expect(gzRes.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gzRes.arrayBuffer())))).toBe(originalHtml)

      const stRes = await app.get('/_plugin/stream')
      expect(stRes.status).toBe(200)
      expect(stRes.headers.get('content-security-policy')).toContain("default-src 'self'")
      const stReader = stRes.body!.getReader()
      const stFirst = await stReader.read()
      expect(decoder.decode(stFirst.value)).toBe('<p>live-1</p>')
      closeRouteStream()
      const stSecond = await stReader.read()
      expect(decoder.decode(stSecond.value)).toBe('<p>live-2</p>')
      expect((await stReader.read()).done).toBe(true)
    })
  })
})
