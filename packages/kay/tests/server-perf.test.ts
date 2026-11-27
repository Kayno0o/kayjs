import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
import { CompressionCache, createServer, isCompressibleType, pickEncoding } from '../src/server/index'
import { Router } from '../src/server/router'
import { verifyOrigin } from '../src/server/security'
import { testApp } from '../src/test/index'

const KAY_PKG_DIR = join(import.meta.dir, '..')
const tempDirs: string[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function linkKay(dir: string): void {
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(KAY_PKG_DIR, join(dir, 'node_modules/@kayjs/kay'), 'dir')
  const pkgRoot = join(KAY_PKG_DIR, '..')
  symlinkSync(join(pkgRoot, 'plugin-seo'), join(dir, 'node_modules/@kayjs/seo'), 'dir')
  symlinkSync(join(pkgRoot, 'plugin-i18n'), join(dir, 'node_modules/@kayjs/i18n'), 'dir')
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('Server compression primitives (compress.ts)', () => {
  it('negotiates zstd and gzip cleanly with q-values and token boundaries', () => {
    expect(pickEncoding(null)).toBeUndefined()
    expect(pickEncoding('')).toBeUndefined()
    expect(pickEncoding('br, deflate')).toBeUndefined()
    expect(pickEncoding('myzstd, notgzip')).toBeUndefined()
    expect(pickEncoding('gzip, deflate, br, zstd')).toBe('zstd')
    expect(pickEncoding('gzip, deflate, br')).toBe('gzip')
    expect(pickEncoding('zstd;q=0, gzip;q=1')).toBe('gzip')
    expect(pickEncoding('gzip;q=0.9, zstd;q=0.5')).toBe('gzip')
    expect(pickEncoding('gzip;q=0.5, zstd;q=0.8')).toBe('zstd')
    expect(pickEncoding('gzip;q=0, zstd;q=0')).toBeUndefined()
  })

  it('classifies compressible MIME types and never buffers SSE or binaries', () => {
    expect(isCompressibleType('text/html; charset=utf-8')).toBe(true)
    expect(isCompressibleType('text/javascript; charset=utf-8')).toBe(true)
    expect(isCompressibleType('application/json; charset=utf-8')).toBe(true)
    expect(isCompressibleType('image/svg+xml')).toBe(true)
    expect(isCompressibleType('application/problem+json')).toBe(true)
    expect(isCompressibleType('text/event-stream')).toBe(false)
    expect(isCompressibleType('text/event-stream; charset=utf-8')).toBe(false)
    expect(isCompressibleType('image/png')).toBe(false)
    expect(isCompressibleType('font/woff2')).toBe(false)
    expect(isCompressibleType(null)).toBe(false)
  })

  it('enforces byte-budget LRU eviction and skips tiny payloads', () => {
    const cache = new CompressionCache(1024)
    const tiny = new TextEncoder().encode('hello')
    expect(cache.compress(tiny, 'gzip', 'tiny')).toBeUndefined()

    const payloadA = new TextEncoder().encode('alpha '.repeat(200))
    const payloadB = new TextEncoder().encode('beta '.repeat(200))
    const outA = cache.compress(payloadA, 'zstd', 'a')
    expect(outA).toBeDefined()
    expect(outA!.byteLength).toBeLessThan(payloadA.byteLength)
    // Cache hit returns exact same Uint8Array instance
    expect(cache.compress(payloadA, 'zstd', 'a')).toBe(outA)

    const outB = cache.compress(payloadB, 'gzip', 'b')
    expect(outB).toBeDefined()
    expect(new TextDecoder().decode(Bun.gunzipSync(outB!))).toBe('beta '.repeat(200))
    expect(new TextDecoder().decode(Bun.zstdDecompressSync(outA!))).toBe('alpha '.repeat(200))
  })
})

describe('Server compression, zero-copy serving, and fast-path preservation (#3518)', () => {
  it('compresses HTML, assets, public files, and JSON API routes while leaving SSE, binaries, and Suspense untouched', async () => {
    const dir = makeTemp('kay-server-perf-')
    mkdirSync(join(dir, 'src/routes/api'), { recursive: true })
    mkdirSync(join(dir, 'src/routes/dyn'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    mkdirSync(join(dir, 'public'), { recursive: true })

    // Large text public file + small binary public file
    writeFileSync(join(dir, 'public/notes.txt'), 'Kay v2 zero-copy public file content.\n'.repeat(40))
    writeFileSync(join(dir, 'public/pixel.png'), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(400).fill(0)]))

    writeFileSync(join(dir, 'src/components/Counter.tsx'), `
      import { signal } from '@kayjs/kay'
      export function Counter() {
        const n = signal(0)
        return <button type="button" onClick={() => n.value++}>Count {n.value}</button>
      }
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Counter } from '../components/Counter'
      export default async function Home() {
        const items = Array.from({ length: 30 }, (_, i) => \`Item \${i} — fast fine-grained SSR\`)
        return (
          <main>
            <h1>Compression Test</h1>
            <Counter />
            <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </main>
        )
      }
    `)

    writeFileSync(join(dir, 'src/routes/cookie.tsx'), `
      import type { RequestContext } from '@kayjs/kay/server'
      export function load(ctx: RequestContext) {
        ctx.cookies.set('sid', 'tok-123')
        return { msg: 'cookie-ok '.repeat(50) }
      }
      export default function CookiePage({ data }: { data: { msg: string } }) {
        return <p>{data.msg}</p>
      }
    `)

    writeFileSync(join(dir, 'src/routes/dyn/[id].tsx'), `
      import type { RequestContext } from '@kayjs/kay/server'
      export function load(ctx: RequestContext) {
        ctx.cookies.set('dyn', ctx.params.id!)
        return { id: ctx.params.id }
      }
      export default function DynCookie({ data }: { data: { id: string } }) {
        return <p>{data.id}</p>
      }
    `)

    writeFileSync(join(dir, 'src/routes/stream.tsx'), `
      import { Suspense } from '@kayjs/kay'
      async function Slow() {
        await Bun.sleep(5)
        return <p id="resolved">${'streamed-payload '.repeat(30)}</p>
      }
      export default function StreamPage() {
        return <Suspense fallback={<p>loading</p>}><Slow /></Suspense>
      }
    `)

    writeFileSync(join(dir, 'src/routes/api/data.ts'), `
      import type { RequestContext } from '@kayjs/kay/server'
      export function GET(ctx: RequestContext) {
        return ctx.json({ rows: Array.from({ length: 40 }, (_, i) => ({ id: i, label: 'row-' + i })) })
      }
    `)

    writeFileSync(join(dir, 'src/routes/api/events.ts'), `
      export function GET() {
        return new Response('data: hello\\n\\n'.repeat(30), {
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        })
      }
    `)

    const manifest = await build({ root: dir })
    const app = await createServer({ root: dir })

    // 1. Dynamic SSR HTML -> zstd + gzip + HEAD
    const zstdRes = await app.handle(new Request('http://localhost/', { headers: { 'accept-encoding': 'gzip, zstd' } }))
    expect(zstdRes.status).toBe(200)
    expect(zstdRes.headers.get('content-encoding')).toBe('zstd')
    expect(zstdRes.headers.get('vary')).toContain('Accept-Encoding')
    const zstdHtml = new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await zstdRes.arrayBuffer())))
    expect(zstdHtml).toContain('<h1>Compression Test</h1>')

    const gzipRes = await app.handle(new Request('http://localhost/', { headers: { 'accept-encoding': 'gzip' } }))
    expect(gzipRes.headers.get('content-encoding')).toBe('gzip')
    const gzipHtml = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gzipRes.arrayBuffer())))
    expect(gzipHtml).toBe(zstdHtml)

    const headRes = await app.handle(new Request('http://localhost/', { method: 'HEAD', headers: { 'accept-encoding': 'zstd' } }))
    expect(headRes.status).toBe(200)
    expect(headRes.headers.get('content-encoding')).toBeNull()
    expect(await headRes.text()).toBe('')

    // 2. Client JS asset -> served directly from precompressed sidecar (.br/.gz) with immutable cache-control
    expect(manifest.runtimeScript).toBeDefined()
    const jsRes = await app.handle(new Request(`http://localhost${manifest.runtimeScript}`, {
      headers: { 'accept-encoding': 'zstd, gzip' },
    }))
    expect(jsRes.status).toBe(200)
    expect(jsRes.headers.get('content-encoding')).toBe('gzip')
    expect(jsRes.headers.get('cache-control')).toContain('immutable')
    const jsText = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await jsRes.arrayBuffer())))
    expect(jsText).toContain('kay-island')

    // 3. Public files: text compressed + 304 ETag works; binary stays uncompressed
    const txtRes = await app.handle(new Request('http://localhost/notes.txt', { headers: { 'accept-encoding': 'gzip' } }))
    expect(txtRes.status).toBe(200)
    expect(txtRes.headers.get('content-encoding')).toBe('gzip')
    const etag = txtRes.headers.get('etag')!
    expect(etag).toBeTruthy()
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await txtRes.arrayBuffer())))).toContain('Kay v2 zero-copy')

    const notMod = await app.handle(new Request('http://localhost/notes.txt', { headers: { 'if-none-match': etag } }))
    expect(notMod.status).toBe(304)

    const pngRes = await app.handle(new Request('http://localhost/pixel.png', { headers: { 'accept-encoding': 'zstd, gzip' } }))
    expect(pngRes.status).toBe(200)
    expect(pngRes.headers.get('content-encoding')).toBeNull()

    // 4. JSON API compressed; SSE never compressed
    const apiRes = await app.handle(new Request('http://localhost/api/data', { headers: { 'accept-encoding': 'zstd' } }))
    expect(apiRes.headers.get('content-encoding')).toBe('zstd')
    const apiJson = JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await apiRes.arrayBuffer())))) as { rows: unknown[] }
    expect(apiJson.rows.length).toBe(40)

    const sseRes = await app.handle(new Request('http://localhost/api/events', { headers: { 'accept-encoding': 'zstd, gzip' } }))
    expect(sseRes.headers.get('content-encoding')).toBeNull()

    // 5. Streaming <Suspense> is never buffered/compressed
    const streamRes = await app.handle(new Request('http://localhost/stream', { headers: { 'accept-encoding': 'zstd, gzip' } }))
    expect(streamRes.headers.get('content-encoding')).toBeNull()
    expect(await streamRes.text()).toContain('streamed-payload')

    // 6. Both fast-path static route & dynamic route emit Set-Cookie ONCE (no missing / double finalizeResponse)
    const cookieRes = await app.handle(new Request('http://localhost/cookie'))
    expect(cookieRes.status).toBe(200)
    const setCookies = cookieRes.headers.getSetCookie()
    expect(setCookies.length).toBe(1)
    expect(setCookies[0]).toContain('sid=tok-123')

    const dynCookieRes = await app.handle(new Request('http://localhost/dyn/42'))
    expect(dynCookieRes.status).toBe(200)
    const dynCookies = dynCookieRes.headers.getSetCookie()
    expect(dynCookies.length).toBe(1)
    expect(dynCookies[0]).toContain('dyn=42')

    // 7. compress: false disables compression
    const uncompressedApp = await createServer({ root: dir, compress: false })
    const rawRes = await uncompressedApp.handle(new Request('http://localhost/', { headers: { 'accept-encoding': 'zstd, gzip' } }))
    expect(rawRes.headers.get('content-encoding')).toBeNull()
    expect(await rawRes.text()).toContain('<h1>Compression Test</h1>')
  })

  it('preserves prerendered fast path with @kayjs/seo & @kayjs/i18n while still respecting route _middleware.ts', async () => {
    const dir = makeTemp('kay-fastpath-plugins-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes/guarded'), { recursive: true })

    const counterFile = join(dir, 'render-count.txt')
    writeFileSync(counterFile, '0')

    const seoPath = join(import.meta.dir, '../../plugin-seo/src/index.ts')
    const i18nPath = join(import.meta.dir, '../../plugin-i18n/src/index.ts')

    writeFileSync(join(dir, 'kay.config.ts'), `
      import { defineConfig } from '@kayjs/kay/config'
      import { seo } from ${JSON.stringify(seoPath)}
      import { i18n } from ${JSON.stringify(i18nPath)}
      export default defineConfig({
        site: 'https://example.test',
        plugins: [
          i18n({ locales: ['en', 'fr'], defaultLocale: 'en', messages: { en: { hi: 'Hello' }, fr: { hi: 'Bonjour' } } }),
          seo({ name: 'Demo', titleTemplate: '%s | Demo', redirects: { '/old': '/' } }),
        ],
      })
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { readFileSync, writeFileSync } from 'node:fs'
      import { Head } from '@kayjs/kay'
      export const prerender = true
      export default function Home({ locals }: { locals: { t?: (k: string) => string } }) {
        const n = Number(readFileSync(${JSON.stringify(counterFile)}, 'utf8')) + 1
        writeFileSync(${JSON.stringify(counterFile)}, String(n))
        return (
          <>
            <Head><title>Home</title></Head>
            <h1>{locals.t ? locals.t('hi') : 'Home'} — ${'content '.repeat(40)}</h1>
          </>
        )
      }
    `)

    writeFileSync(join(dir, 'src/routes/guarded/_middleware.ts'), `
      import type { Middleware } from '@kayjs/kay/server'
      const mw: Middleware = async (ctx, next) => {
        if (ctx.request.headers.get('x-allow') !== '1')
          return ctx.text('Forbidden', { status: 403 })
        const res = await next()
        res.headers.set('x-guarded', 'yes')
        return res
      }
      export default mw
    `)

    writeFileSync(join(dir, 'src/routes/guarded/index.tsx'), `
      export const prerender = true
      export default function Secret() {
        return <p>Guarded prerendered page ${'secret '.repeat(40)}</p>
      }
    `)

    const app = await testApp({ root: dir })
    const countAfterBuild = Number(await Bun.file(counterFile).text())
    expect(countAfterBuild).toBe(2) // en + fr prerendered during build

    // Subsequent requests for / and /fr must hit prerendered fast path (0 re-renders!) and compress cleanly
    const enRes = await app.fetch(new Request('http://localhost/', { headers: { 'accept-encoding': 'zstd' } }))
    expect(enRes.status).toBe(200)
    expect(enRes.headers.get('content-encoding')).toBe('zstd')
    const enHtml = new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await enRes.arrayBuffer())))
    expect(enHtml).toContain('<title>Home | Demo</title>')
    expect(enHtml).toContain('<html lang="en">')
    expect(enHtml).toContain('<link rel="canonical" href="https://example.test/">')
    expect(enHtml).toContain('<link rel="alternate" hreflang="fr" href="https://example.test/fr">')

    const frRes = await app.fetch(new Request('http://localhost/fr', { headers: { 'accept-encoding': 'gzip' } }))
    expect(frRes.status).toBe(200)
    expect(frRes.headers.get('content-encoding')).toBe('gzip')
    const frHtml = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await frRes.arrayBuffer())))
    expect(frHtml).toContain('<html lang="fr">')
    expect(frHtml).toContain('Bonjour')
    expect(frHtml).toContain('<link rel="canonical" href="https://example.test/fr">')

    expect(Number(await Bun.file(counterFile).text())).toBe(countAfterBuild)

    // Plugin redirect still wins
    const redir = await app.get('/old')
    expect(redir.status).toBe(301)
    expect(redir.headers.get('location')).toBe('/')

    // Route _middleware.ts still runs even on prerendered routes
    const denied = await app.get('/guarded')
    expect(denied.status).toBe(403)

    const allowed = await app.fetch(new Request('http://localhost/guarded', { headers: { 'x-allow': '1' } }))
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('x-guarded')).toBe('yes')
    expect(await allowed.text()).toContain('Guarded prerendered page')
  })

  it('embeds prerendered HTML via with { type: "file" } in --compile and serves compressed over live Bun.serve', async () => {
    const dir = makeTemp('kay-compile-pre-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export const prerender = true
      export default function Home() {
        return <main><h1>Compiled Prerender</h1><p>${'zero-copy embedded html '.repeat(40)}</p></main>
      }
    `)

    const binPath = join(dir, 'dist/pre-bin')
    await build({ root: dir, compile: binPath })
    expect(existsSync(binPath)).toBe(true)

    const proc = Bun.spawn([binPath], {
      env: { ...process.env, PORT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      const reader = proc.stdout.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (!buf.includes('listening on')) {
        const { done, value } = await reader.read()
        if (done)
          throw new Error(`compiled binary exited early: ${buf} ${await new Response(proc.stderr).text()}`)
        buf += dec.decode(value)
      }
      reader.releaseLock()
      const port = Number(/listening on http:\/\/[^:]+:(\d+)/.exec(buf)![1])

      // Use raw TCP/Bun.fetch with decompress: false to verify Content-Encoding on the wire!
      const zstdRes = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { 'accept-encoding': 'zstd' },
        decompress: false,
      })
      expect(zstdRes.status).toBe(200)
      expect(zstdRes.headers.get('content-encoding')).toBe('zstd')
      expect(zstdRes.headers.get('vary')).toContain('Accept-Encoding')
      const body = new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await zstdRes.arrayBuffer())))
      expect(body).toContain('Compiled Prerender')

      // The build hashed the embedded page, so the binary answers a 304 to its ETag.
      const etag = zstdRes.headers.get('etag')!
      expect(etag).toMatch(/^W\/"/)
      const notModified = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'if-none-match': etag } })
      expect(notModified.status).toBe(304)
    }
    finally {
      proc.kill()
      await proc.exited
    }
  })
})

describe('files served as they are (#3667)', () => {
  it('answers a prerendered page, an asset and a public file with an ETag, a 304 to it, and their length to HEAD', async () => {
    const dir = makeTemp('kay-served-file-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, 'public/notes.txt'), 'twelve bytes')
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export const prerender = true
      export default function Home() { return <main><h1>Prerendered</h1></main> }
    `)
    await build({ root: dir })
    const manifest = await Bun.file(join(dir, 'dist/manifest.json')).json() as { runtimeScript: string }
    const app = await createServer({ root: dir })

    const page = await app.handle(new Request('http://localhost/'))
    const html = await page.text()
    const etag = page.headers.get('etag')!
    expect(etag).toMatch(/^W\/"/)
    const notModified = await app.handle(new Request('http://localhost/', { headers: { 'if-none-match': etag } }))
    expect(notModified.status).toBe(304)
    expect(await notModified.text()).toBe('')

    const pageHead = await app.handle(new Request('http://localhost/', { method: 'HEAD' }))
    expect(pageHead.headers.get('content-length')).toBe(String(Buffer.byteLength(html)))
    expect(await pageHead.text()).toBe('')

    const script = await (await app.handle(new Request(`http://localhost${manifest.runtimeScript}`))).arrayBuffer()
    const scriptHead = await app.handle(new Request(`http://localhost${manifest.runtimeScript}`, { method: 'HEAD' }))
    expect(scriptHead.headers.get('content-length')).toBe(String(script.byteLength))

    const publicHead = await app.handle(new Request('http://localhost/notes.txt', { method: 'HEAD' }))
    expect(publicHead.headers.get('content-length')).toBe('12')
  })
})

describe('compression work per request', () => {
  it('compresses a file once whatever its size, gives up once on one that does not shrink, and never keeps private pages', async () => {
    const dir = makeTemp('kay-compress-once-')
    mkdirSync(join(dir, 'src/routes/api'), { recursive: true })
    mkdirSync(join(dir, 'public'), { recursive: true })
    // Base64 of random bytes shrinks by a quarter only, so 1 MB of it stays over 512 KB compressed.
    const random = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256))
    writeFileSync(join(dir, 'public/big.txt'), Buffer.from(random(800_000)).toString('base64'))
    writeFileSync(join(dir, 'public/noise.txt'), random(4096))
    writeFileSync(join(dir, 'src/routes/me.tsx'), `
      export function load() { return { name: 'Ada '.repeat(200) } }
      export default function Me({ data }: { data: { name: string } }) { return <p>{data.name}</p> }
    `)
    writeFileSync(join(dir, 'src/routes/about.tsx'), `
      export default function About() { return <p>{'About us. '.repeat(100)}</p> }
    `)
    writeFileSync(join(dir, 'src/routes/api/me.ts'), `
      export function GET(ctx) { return ctx.json({ name: 'Ada '.repeat(200) }) }
    `)
    await build({ root: dir })
    const app = await createServer({ root: dir, compress: true })
    const get = async (path: string) => {
      const res = await app.handle(new Request(`http://localhost${path}`, { headers: { 'accept-encoding': 'zstd' } }))
      await res.arrayBuffer()
      return res
    }
    const spy = spyOn(Bun, 'zstdCompressSync')
    try {
      const counted = async (path: string) => {
        spy.mockClear()
        const first = await get(path)
        await get(path)
        return [first.headers.get('content-encoding'), spy.mock.calls.length]
      }
      expect(await counted('/big.txt')).toEqual(['zstd', 1])
      expect(await counted('/noise.txt')).toEqual([null, 1])
      expect(await counted('/about')).toEqual(['zstd', 1])
      expect(await counted('/me')).toEqual(['zstd', 2])
      expect(await counted('/api/me')).toEqual(['zstd', 2])
    }
    finally {
      spy.mockRestore()
    }
  })
})

describe('Server hot-path allocations (#3557)', () => {
  it('Router sorts lazily on first match and skips param decoding on non-matching dynamic routes', () => {
    const sortSpy = spyOn(Array.prototype, 'sort')
    const decodeSpy = spyOn(globalThis, 'decodeURIComponent')
    try {
      const router = new Router<string>()
      router.add('/files/*rest', 'catchall')
      router.add('/:org/:repo/settings', 'settings')
      router.add('/:org/:repo/issues/:id', 'issue')
      router.add('/static/about', 'static')

      // Adding dynamic routes must not re-sort on every add()
      expect(sortSpy).not.toHaveBeenCalled()

      // First match sorts once; non-matching candidate (:org/:repo/issues/:id) must NOT decode params
      const m = router.match('/acme/kay%20v2/settings')
      expect(sortSpy).toHaveBeenCalledTimes(1)
      expect(m).toEqual({ data: 'settings', params: { org: 'acme', repo: 'kay v2' } })
      // Only the winning route's two params were decoded (not any rejected candidate's params)
      expect(decodeSpy).toHaveBeenCalledTimes(2)

      // Subsequent match does not re-sort
      sortSpy.mockClear()
      decodeSpy.mockClear()
      const m2 = router.match('/acme/kay/issues/42')
      expect(sortSpy).not.toHaveBeenCalled()
      expect(m2).toEqual({ data: 'issue', params: { org: 'acme', repo: 'kay', id: '42' } })
      expect(decodeSpy).toHaveBeenCalledTimes(3)

      // Encoded slash rejected without decoding
      decodeSpy.mockClear()
      expect(router.match('/acme/bad%2Frepo/settings')).toBeUndefined()
      expect(decodeSpy).not.toHaveBeenCalled()
    }
    finally {
      sortSpy.mockRestore()
      decodeSpy.mockRestore()
    }
  })

  it('verifyOrigin reuses pre-parsed requestUrl without re-parsing request.url', () => {
    const req = new Request('https://example.test/api/items', {
      method: 'POST',
      headers: { origin: 'https://example.test' },
    })
    const url = new URL(req.url)
    const origURL = globalThis.URL
    let calls = 0
    const CountingURL = new Proxy(origURL, {
      construct(target, args, newTarget) {
        calls++
        return Reflect.construct(target, args, newTarget)
      },
    })
    ;(globalThis as unknown as { URL: typeof URL }).URL = CountingURL
    try {
      expect(verifyOrigin(req, undefined, false, url)).toEqual({ ok: true })
      expect(calls).toBe(0)
    }
    finally {
      ;(globalThis as unknown as { URL: typeof URL }).URL = origURL
    }
  })
})
