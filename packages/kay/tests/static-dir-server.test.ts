import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { build } from '../src/build/index'
import { resolveServerConfig } from '../src/plugins/index'
import { CompressionCache, maybeCompressResponse } from '../src/server/compress'
import { createServer } from '../src/server/index'
import { createStaticDirServer } from '../src/server/static-dir'
import { testApp } from '../src/test/index'

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

describe('createStaticDirServer boundary tests & ServerRuntimeConfig / rootLayoutFile (#3569)', () => {
  it('blocks path traversal, null bytes, and unsupported methods (405 + Allow)', async () => {
    const parent = makeTemp('kay-static-parent-')
    const outDir = join(parent, 'dist')
    mkdirSync(join(outDir, '_kay'), { recursive: true })
    writeFileSync(join(parent, 'secret.txt'), 'TOP_SECRET')
    writeFileSync(join(outDir, 'index.html'), '<!DOCTYPE html><h1>Home</h1>')

    const app = createStaticDirServer(outDir, '/_kay', undefined, true, false)

    // Path traversal attempts (raw, URL-encoded, double-dot, null byte) must never escape outDir
    for (const badPath of ['/../secret.txt', '/%2e%2e/secret.txt', '/sub/../../secret.txt', '/index%00.html', '/%c0%afsecret.txt']) {
      const res = await app.handle(new Request(`http://localhost${badPath}`))
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('TOP_SECRET')
    }

    // Unsafe methods return 405 with Allow: GET, HEAD
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.handle(new Request('http://localhost/', { method }))
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('GET, HEAD')
    }
  })

  it('serves 304 ETag, precompressed .br/.gz sidecars, immutable asset headers, and custom 404.html', async () => {
    const outDir = makeTemp('kay-static-dir-')
    mkdirSync(join(outDir, '_kay'), { recursive: true })
    mkdirSync(join(outDir, 'about'), { recursive: true })

    const jsRaw = new TextEncoder().encode('export const hello = "world";\n'.repeat(40))
    const jsBr = new Uint8Array(brotliCompressSync(jsRaw))
    const jsGz = new Uint8Array(gzipSync(jsRaw))
    writeFileSync(join(outDir, '_kay/app-abc.js'), jsRaw)
    writeFileSync(join(outDir, '_kay/app-abc.js.br'), jsBr)
    writeFileSync(join(outDir, '_kay/app-abc.js.gz'), jsGz)
    writeFileSync(join(outDir, 'about/index.html'), '<!DOCTYPE html><h1>About</h1>')
    writeFileSync(join(outDir, '404.html'), '<!DOCTYPE html><h1>Custom Not Found</h1>')

    const app = createStaticDirServer(outDir, '/_kay', { hsts: true }, true, true)

    // 1. Clean URL resolves to about/index.html with ETag & 304 Not Modified
    const aboutRes = await app.handle(new Request('http://localhost/about'))
    expect(aboutRes.status).toBe(200)
    expect(await aboutRes.text()).toContain('<h1>About</h1>')
    expect(aboutRes.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    const etag = aboutRes.headers.get('etag')
    expect(etag).toBeTruthy()

    const notMod = await app.handle(new Request('http://localhost/about', {
      headers: { 'if-none-match': etag! },
    }))
    expect(notMod.status).toBe(304)
    expect(await notMod.text()).toBe('')

    // 2. Precompressed .br and .gz sidecars under assetPrefix get immutable cache-control + Vary + weak ETag
    const brRes = await app.handle(new Request('http://localhost/_kay/app-abc.js', {
      headers: { 'accept-encoding': 'br, gzip' },
    }))
    expect(brRes.status).toBe(200)
    expect(brRes.headers.get('content-encoding')).toBe('br')
    expect(brRes.headers.get('vary')).toBe('Accept-Encoding')
    expect(brRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(new Uint8Array(await brRes.arrayBuffer())).toEqual(jsBr)

    const gzRes = await app.handle(new Request('http://localhost/_kay/app-abc.js', {
      headers: { 'accept-encoding': 'gzip' },
    }))
    expect(gzRes.status).toBe(200)
    expect(gzRes.headers.get('content-encoding')).toBe('gzip')
    expect(new Uint8Array(await gzRes.arrayBuffer())).toEqual(jsGz)

    // 3. HEAD returns empty body with headers intact
    const headRes = await app.handle(new Request('http://localhost/_kay/app-abc.js', { method: 'HEAD' }))
    expect(headRes.status).toBe(200)
    expect(await headRes.text()).toBe('')

    // 4. Missing route serves custom 404.html (and empty body on HEAD)
    const nfRes = await app.handle(new Request('http://localhost/does-not-exist'))
    expect(nfRes.status).toBe(404)
    expect(await nfRes.text()).toContain('Custom Not Found')

    const nfHead = await app.handle(new Request('http://localhost/does-not-exist', { method: 'HEAD' }))
    expect(nfHead.status).toBe(404)
    expect(await nfHead.text()).toBe('')

    // 5. HSTS header applied in production when trustProxy sees HTTPS
    const prevEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const httpsRes = await app.handle(new Request('http://localhost/about', {
        headers: { 'x-forwarded-proto': 'https' },
      }))
      expect(httpsRes.headers.get('strict-transport-security')).toContain('max-age=')
    }
    finally {
      if (prevEnv === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = prevEnv
    }
  })

  it('hashes each exported page\'s own <style> blocks into its CSP, following a page rewritten on disk (#3582)', async () => {
    const outDir = makeTemp('kay-static-style-')
    writeFileSync(join(outDir, 'index.html'), '<!DOCTYPE html><style>main{color:red}</style><main>Home</main>')
    writeFileSync(join(outDir, '404.html'), '<!DOCTYPE html><style>p{margin:0}</style><p>Missing</p>')
    const app = createStaticDirServer(outDir, '/_kay', undefined, false, false)

    const home = await app.handle(new Request('http://localhost/'))
    expect(home.headers.get('content-security-policy')).toContain(`style-src 'self' 'sha256-UvgDGLSJZozI65SAyh4YlF4q7thtrvbjY5VYKzwpjmQ=' 'sha256-ac1R1kU5izDDnXGpZrb2k+Dct4jThB3/YH1VfglrT3I='`)
    const missing = await app.handle(new Request('http://localhost/nope'))
    expect(missing.headers.get('content-security-policy')).toContain(`'sha256-QRQPRLGyxt3RJiKpYNjpkgHcmHU2PywsfL2e8oI0LQA='`)

    writeFileSync(join(outDir, 'index.html'), '<!DOCTYPE html><style>p{margin:0}</style><main>Home, edited</main>')
    const edited = await app.handle(new Request('http://localhost/'))
    expect(edited.headers.get('content-security-policy')).toContain(`'sha256-QRQPRLGyxt3RJiKpYNjpkgHcmHU2PywsfL2e8oI0LQA='`)
    expect(edited.headers.get('content-security-policy')).not.toContain(`'sha256-ac1R1kU5izDDnXGpZrb2k+Dct4jThB3/YH1VfglrT3I='`)
  })

  it('stores rootLayoutFile explicitly: never leaks a subdirectory _layout.tsx into 404, and loads root _layout.tsx even with zero page routes', async () => {
    // Case A: only a subdirectory `admin/_layout.tsx` + root `_404.tsx` -> 404 MUST NOT render inside admin layout!
    const dirA = makeTemp('kay-sub-layout-404-')
    mkdirSync(join(dirA, 'src/routes/admin'), { recursive: true })
    writeFileSync(join(dirA, 'src/routes/admin/_layout.tsx'), `
      export default function AdminLayout({ children }: { children: unknown }) {
        return <div class="admin-only">{children}</div>
      }
    `)
    writeFileSync(join(dirA, 'src/routes/admin/index.tsx'), 'export default function Admin() { return <h1>Admin</h1> }\n')
    writeFileSync(join(dirA, 'src/routes/_404.tsx'), 'export default function NotFound() { return <h1>Missing</h1> }\n')

    const mA = await build({ root: dirA, minify: false })
    expect(mA.rootLayoutFile).toBeUndefined()
    const appA = await createServer({ root: dirA })
    const resA = await appA.handle(new Request('http://localhost/nope'))
    expect(resA.status).toBe(404)
    const htmlA = await resA.text()
    expect(htmlA).toContain('<h1>Missing</h1>')
    expect(htmlA).not.toContain('admin-only')

    // Case B: root `_layout.tsx` + `_404.tsx` with NO page routes -> 404 STILL wraps in root layout!
    const dirB = makeTemp('kay-root-layout-only-')
    mkdirSync(join(dirB, 'src/routes'), { recursive: true })
    writeFileSync(join(dirB, 'src/routes/_layout.tsx'), `
      export default function RootLayout({ children }: { children: unknown }) {
        return <div class="root-shell">{children}</div>
      }
    `)
    writeFileSync(join(dirB, 'src/routes/_404.tsx'), 'export default function NotFound() { return <h1>Lost</h1> }\n')

    const mB = await build({ root: dirB, minify: false })
    expect(mB.rootLayoutFile).toBeDefined()
    const appB = await createServer({ root: dirB })
    const resB = await appB.handle(new Request('http://localhost/anything'))
    expect(resB.status).toBe(404)
    const htmlB = await resB.text()
    expect(htmlB).toContain('root-shell')
    expect(htmlB).toContain('<h1>Lost</h1>')
  })

  it('resolveServerConfig merges fileConfig with overrides and testApp forwards compress & onError', async () => {
    const merged = resolveServerConfig(
      { site: 'https://a.test', lang: 'fr', compress: true, streamTimeout: 5000, port: 4000, outDir: 'build' },
      { lang: 'en', compress: false, site: undefined },
    )
    expect(merged.site).toBe('https://a.test')
    expect(merged.lang).toBe('en')
    expect(merged.compress).toBe(false)
    expect(merged.streamTimeout).toBe(5000)
    expect('port' in merged).toBe(false)
    expect('outDir' in merged).toBe(false)

    const dir = makeTemp('kay-testapp-cfg-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/boom.tsx'), `
      export function load() { throw new Error('kaboom-3569') }
      export default function Boom() { return <p>never</p> }
    `)
    const errors: unknown[] = []
    const app = await testApp({
      root: dir,
      compress: false,
      onError: info => errors.push(info.error),
    })
    const res = await app.get('/boom', { 'accept-encoding': 'zstd, gzip' })
    expect(res.status).toBe(500)
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(errors.length).toBe(1)
  })

  it('maybeCompressResponse preserves all chunks on open streams without Bun.inspect', async () => {
    const cache = new CompressionCache()
    const req = new Request('http://localhost/stream', { headers: { 'accept-encoding': 'gzip' } })
    let ctrl!: ReadableStreamDefaultController<Uint8Array>
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c
        c.enqueue(enc.encode('part-1:'))
      },
    })
    const res = new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
    const out = await maybeCompressResponse(res, req, cache)
    expect(out.headers.get('content-encoding')).toBeNull()

    setTimeout(() => {
      ctrl.enqueue(enc.encode('part-2'))
      ctrl.close()
    }, 10)
    expect(await out.text()).toBe('part-1:part-2')
  })
})
