import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActionRegistry } from '../src/server/action-registry'
import { createAssets } from '../src/server/assets'
import {
  CompressionCache,
  compressedHtmlResponse,
  markCompressionHandled,
  maybeCompressResponse,
} from '../src/server/compress'
import { createHtmlHeaders } from '../src/server/document'
import * as envMod from '../src/server/env'
import { applyHstsHeader, finalizeResponse, notFound } from '../src/server/http'
import { currentRequest } from '../src/server/request-scope'
import { createFastStaticPageHandler } from '../src/server/routing'
import { buildSecurityHeaderEntries, getClientIp, isHttpsRequest, resolveHstsValue, verifyOrigin } from '../src/server/security'
import { createStaticDirServer } from '../src/server/static-dir'
import { raw, ssrChild } from '../src/ssr/index'
import { currentRenderContext, ssrStyleBlock } from '../src/ssr/context'
import { Region } from '../src/ssr/region'

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

describe('#3637 item 3 — avoid double compression and unhandled pendingRead rejections', () => {
  it('markCompressionHandled skips redundant body reading and compression in maybeCompressResponse', async () => {
    const cache = new CompressionCache()
    const req = new Request('http://localhost/page', { headers: { 'accept-encoding': 'zstd, gzip' } })
    const spy = spyOn(Bun, 'zstdCompressSync')
    try {
      // 1. Marked stream is returned verbatim without touching res.body
      let pulled = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++
          c.enqueue(new TextEncoder().encode('streamed '.repeat(80)))
          c.close()
        },
      }, { highWaterMark: 0 })
      const streamed = markCompressionHandled(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }))
      const out = await maybeCompressResponse(streamed, req, cache)
      expect(out).toBe(streamed)
      expect(pulled).toBe(0)
      expect(spy).not.toHaveBeenCalled()

      // 2. Small HTML from compressedHtmlResponse() is already marked -> maybeCompressResponse is a no-op
      const smallRes = compressedHtmlResponse('<p>hi</p>', 200, { 'content-type': 'text/html; charset=utf-8' }, req, cache)
      expect(smallRes.headers.get('content-encoding')).toBeNull()
      expect(await maybeCompressResponse(smallRes, req, cache)).toBe(smallRes)
      expect(spy).not.toHaveBeenCalled()

      // 3. serveFile() marks uncompressed / non-shrinking responses so maybeCompressResponse never re-compresses
      const noise = Uint8Array.from({ length: 4096 }, (_, i) => (i * 197 + 31) ^ (i * 53))
      const files = createAssets({
        assets: {},
        assetPrefix: '/_kay',
        isDev: false,
        compressEnabled: true,
        compressCache: cache,
        nosniffHeader: { 'x-content-type-options': 'nosniff' },
        securityRecord: {},
        withHsts: res => res,
      })
      files.registerPublic('noise.txt', noise)
      const pub = files.publicMap.get('/noise.txt')!
      const served = await files.serveFile(req, pub.file)
      const callsAfterServe = spy.mock.calls.length
      expect(await maybeCompressResponse(served, req, cache)).toBe(served)
      expect(spy.mock.calls.length).toBe(callsAfterServe)
    }
    finally {
      spy.mockRestore()
    }
  })

  it('does not trigger an unhandled rejection when a passthrough stream is cancelled before pendingRead settles', async () => {
    const cache = new CompressionCache()
    const req = new Request('http://localhost/stream', { headers: { 'accept-encoding': 'gzip' } })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      let ctrl!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c
          c.enqueue(new TextEncoder().encode('chunk-0'))
        },
      })
      const res = new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
      const passthrough = await maybeCompressResponse(res, req, cache)
      expect(passthrough.headers.get('content-encoding')).toBeNull()

      // Error the underlying stream BEFORE draining/cancelling passthrough (pendingRead rejects!)
      ctrl.error(new Error('upstream aborted'))
      await Bun.sleep(15)
      expect(unhandled).toEqual([])
      await passthrough.body!.cancel().catch(() => {})
      await Bun.sleep(15)
      expect(unhandled).toEqual([])

      // When a consumer DOES read past buffered chunks, the error still propagates cleanly
      let ctrl2!: ReadableStreamDefaultController<Uint8Array>
      const stream2 = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl2 = c
          c.enqueue(new TextEncoder().encode('chunk-0'))
        },
      })
      const res2 = new Response(stream2, { status: 200, headers: { 'content-type': 'text/plain' } })
      const passthrough2 = await maybeCompressResponse(res2, req, cache)
      ctrl2.error(new Error('downstream read fail'))
      await expect(passthrough2.text()).rejects.toThrow('downstream read fail')
      await Bun.sleep(15)
      expect(unhandled).toEqual([])
    }
    finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('#3637 item 4 — static-dir.ts async I/O and CompressionCache reuse', () => {
  it('caches compressed buffers across requests and invalidates when file ETag changes on disk', async () => {
    const outDir = makeTemp('kay-static-cache-')
    mkdirSync(join(outDir, '_kay'), { recursive: true })
    const pagePath = join(outDir, 'index.html')
    const noisePath = join(outDir, 'noise.txt')
    writeFileSync(pagePath, `<!DOCTYPE html><main>${'static directory compression cache '.repeat(40)}</main>`)
    // Cryptographically random bytes will not shrink under zstd
    const randomBytes = crypto.getRandomValues(new Uint8Array(4096))
    writeFileSync(noisePath, randomBytes)

    const app = createStaticDirServer(outDir, '/_kay', undefined, true, false)
    const spy = spyOn(Bun, 'zstdCompressSync')
    try {
      // 1. First request compresses and caches; second request hits CompressionCache.#files (0 extra compressions)
      const r1 = await app.handle(new Request('http://localhost/', { headers: { 'accept-encoding': 'zstd' } }))
      expect(r1.status).toBe(200)
      expect(r1.headers.get('content-encoding')).toBe('zstd')
      const body1 = new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await r1.arrayBuffer())))
      expect(body1).toContain('static directory compression cache')
      expect(spy).toHaveBeenCalledTimes(1)

      const r2 = await app.handle(new Request('http://localhost/', { headers: { 'accept-encoding': 'zstd' } }))
      expect(r2.status).toBe(200)
      expect(r2.headers.get('content-encoding')).toBe('zstd')
      const body2 = new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await r2.arrayBuffer())))
      expect(body2).toBe(body1)
      expect(spy).toHaveBeenCalledTimes(1)

      // 2. Updating the file changes size/ETag -> cache key changes -> serves updated content
      writeFileSync(pagePath, `<!DOCTYPE html><main>${'updated static directory content! '.repeat(45)}</main>`)
      const r3 = await app.handle(new Request('http://localhost/', { headers: { 'accept-encoding': 'zstd' } }))
      expect(r3.status).toBe(200)
      expect(r3.headers.get('content-encoding')).toBe('zstd')
      const body3 = new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await r3.arrayBuffer())))
      expect(body3).toContain('updated static directory content!')
      expect(spy).toHaveBeenCalledTimes(2)

      // 3. Non-shrinking file is cached as null after first attempt (1 compression call across 2 requests)
      spy.mockClear()
      const n1 = await app.handle(new Request('http://localhost/noise.txt', { headers: { 'accept-encoding': 'zstd' } }))
      expect(n1.status).toBe(200)
      expect(n1.headers.get('content-encoding')).toBeNull()
      expect(n1.headers.get('vary')).toBe('Accept-Encoding')
      expect(new Uint8Array(await n1.arrayBuffer())).toEqual(randomBytes)

      const n2 = await app.handle(new Request('http://localhost/noise.txt', { headers: { 'accept-encoding': 'zstd' } }))
      expect(n2.status).toBe(200)
      expect(n2.headers.get('content-encoding')).toBeNull()
      expect(n2.headers.get('vary')).toBe('Accept-Encoding')
      expect(new Uint8Array(await n2.arrayBuffer())).toEqual(randomBytes)
      expect(spy).toHaveBeenCalledTimes(1)
    }
    finally {
      spy.mockRestore()
    }
  })
})

describe('#3637 item 5 — allocation-free X-Forwarded-* parsing and fast applyHstsHeader', () => {
  it('parses X-Forwarded-Proto/For/Host from the right without calling String.prototype.split', () => {
    const splitSpy = spyOn(String.prototype, 'split')
    try {
      const req = (headers: Record<string, string>, url = 'http://app.example/') => new Request(url, { method: 'POST', headers })

      expect(isHttpsRequest(req({ 'x-forwarded-proto': 'https' }), true)).toBe(true)
      expect(isHttpsRequest(req({ 'x-forwarded-proto': 'HTTPS' }), true)).toBe(true)
      expect(isHttpsRequest(req({ 'x-forwarded-proto': 'http, https' }), true)).toBe(true)
      expect(isHttpsRequest(req({ 'x-forwarded-proto': 'https, http' }), true)).toBe(false)
      expect(isHttpsRequest(req({ 'x-forwarded-proto': 'http, https, ' }), true)).toBe(true)
      expect(isHttpsRequest(req({ 'x-forwarded-proto': 'http, https, http' }), 2)).toBe(true)
      expect(isHttpsRequest(req({ 'x-forwarded-proto': 'https' }), 2)).toBe(false)
      expect(isHttpsRequest(req({ 'x-forwarded-proto': '   ' }), true)).toBe(false)
      expect(isHttpsRequest(req({ 'x-forwarded-proto': 'https' }), false)).toBe(false)
      expect(isHttpsRequest(req({}, 'https://app.example/'), false)).toBe(true)

      expect(getClientIp(req({ 'x-forwarded-for': 'spoofed, 203.0.113.5, 198.51.100.7' }), 2, '10.0.0.1')).toBe('203.0.113.5')
      expect(getClientIp(req({ 'x-forwarded-for': 'a,,b' }), 2, '10.0.0.1')).toBe('a')
      expect(verifyOrigin(req({ 'origin': 'https://app.example', 'x-forwarded-proto': 'http, https', 'x-forwarded-host': 'evil.example, app.example' }), undefined, true).ok).toBe(true)

      expect(splitSpy).not.toHaveBeenCalled()
    }
    finally {
      splitSpy.mockRestore()
    }
  })

  it('skips nodeEnv()/process.env reads on HTTP, dev, and hsts:false requests while honoring production HTTPS', () => {
    const hsts = resolveHstsValue(undefined)!
    const envSpy = spyOn(envMod, 'nodeEnv').mockReturnValue('production')
    try {
      // Plain HTTP (trustProxy=false): must NOT call nodeEnv()
      const httpReq = new Request('http://example.com/_kay/app.js')
      applyHstsHeader(new Response('ok'), httpReq, hsts, false, false)
      expect(envSpy).not.toHaveBeenCalled()

      // Plain HTTP behind proxy with X-Forwarded-Proto: http: must NOT call nodeEnv()
      const httpProxyReq = new Request('http://example.com/_kay/app.js', { headers: { 'x-forwarded-proto': 'http' } })
      applyHstsHeader(new Response('ok'), httpProxyReq, hsts, true, false)
      expect(envSpy).not.toHaveBeenCalled()

      // Dev mode on HTTPS: must NOT call nodeEnv()
      const httpsReq = new Request('https://example.com/')
      applyHstsHeader(new Response('ok'), httpsReq, hsts, false, true)
      expect(envSpy).not.toHaveBeenCalled()

      // HSTS disabled on HTTPS: must NOT call nodeEnv()
      applyHstsHeader(new Response('ok'), httpsReq, undefined, false, false)
      expect(envSpy).not.toHaveBeenCalled()

      // Explicit resolvedEnv on HTTPS: skips nodeEnv() too
      const withExplicit = applyHstsHeader(new Response('ok'), httpsReq, hsts, false, false, 'production')
      expect(withExplicit.headers.get('strict-transport-security')).toBe(hsts)
      expect(envSpy).not.toHaveBeenCalled()

      // Without explicit resolvedEnv on HTTPS in prod: emits HSTS
      const prodRes = applyHstsHeader(new Response('ok'), httpsReq, hsts, false, false)
      expect(prodRes.headers.get('strict-transport-security')).toBe(hsts)
      expect(envSpy).toHaveBeenCalledTimes(1)
    }
    finally {
      envSpy.mockRestore()
    }
  })
})

describe('#3604 — createFastStaticPageHandler parity with renderCompiledRoute', () => {
  function makeHandler(opts: {
    mod: Parameters<typeof createFastStaticPageHandler>[0]['mod']
    layouts?: Parameters<typeof createFastStaticPageHandler>[0]['layouts']
    entry?: Partial<Parameters<typeof createFastStaticPageHandler>[0]['entry']>
    hasLoad?: boolean
    compressCache?: CompressionCache
    errors?: unknown[]
  }) {
    const securityEntries = buildSecurityHeaderEntries(undefined)
    const securityRecord = Object.fromEntries(securityEntries)
    const htmlHeaders = createHtmlHeaders(undefined, securityRecord)
    const withHsts = (res: Response, req: Request) => applyHstsHeader(res, req, resolveHstsValue(undefined), false, false)
    const finish = (res: Response, req: Request, cookieStore?: Parameters<typeof finalizeResponse>[1]) =>
      withHsts(finalizeResponse(res, cookieStore, securityEntries), req)
    const errors = opts.errors ?? []

    return createFastStaticPageHandler({
      entry: {
        path: '/test',
        file: 'server/test.js',
        layouts: [],
        middlewares: [],
        islandChunks: [],
        hasLoad: opts.hasLoad ?? false,
        ...opts.entry,
      },
      mod: opts.mod,
      layouts: opts.layouts ?? [],
      doc: { body: '', lang: 'en', styles: [] },
      hasIslands: Boolean(opts.entry?.islandChunks?.length),
      hasLoad: opts.hasLoad ?? false,
      trustProxy: false,
      htmlHeaders,
      compressCache: opts.compressCache ?? new CompressionCache(),
      actions: createActionRegistry(),
      buildNotFoundResponse: async () => new Response(`<!DOCTYPE html><h1>404 ${'missing '.repeat(50)}</h1>`, {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
      renderError: async (error, cookieStore, _url, req) => finish(new Response(`ERR:${(error as Error).message}`, { status: 500 }), req, cookieStore),
      notifyError: (error) => { errors.push(error) },
      finish,
      withHsts,
    })
  }

  it('keeps actions.run() active when !hasLoad, adds Vary: x-kay-region for <Region>, hashes inline styles, and handles HEAD', async () => {
    let sawRequestScope = false
    const handler = makeHandler({
      hasLoad: false,
      mod: {
        default() {
          sawRequestScope = currentRequest() !== undefined
          expect(currentRenderContext()).toBeDefined()
          const css = ssrStyleBlock('.fast{color:green}')
          const region = Region({ name: 'feed', children: raw(`<p>${'region content '.repeat(30)}</p>`) })
          return raw(`<style>${css}</style>${ssrChild(region)}`)
        },
      },
    })

    const res = await handler(new Request('http://localhost/test', { headers: { 'accept-encoding': 'zstd' } }))
    expect(res.status).toBe(200)
    expect(sawRequestScope).toBe(true)
    expect(res.headers.get('content-encoding')).toBe('zstd')
    const vary = res.headers.get('vary') ?? ''
    expect(vary).toContain('x-kay-region')
    expect(vary).toContain('Accept-Encoding')
    expect(res.headers.get('content-security-policy')).toContain("'sha256-")

    const html = new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(await res.arrayBuffer())))
    expect(html).toContain('data-kay-region="feed"')
    expect(html).toContain('.fast{color:green}')

    // HEAD returns empty body with headers intact and no content-encoding
    const headRes = await handler(new Request('http://localhost/test', { method: 'HEAD', headers: { 'accept-encoding': 'zstd' } }))
    expect(headRes.status).toBe(200)
    expect(headRes.headers.get('content-encoding')).toBeNull()
    expect(headRes.headers.get('vary')).toContain('x-kay-region')
    expect(await headRes.text()).toBe('')
  })

  it('handles load() notFound() (return & throw), compressible Response return, cookies, page-island props, and error reporting', async () => {
    // 1. Returned & thrown notFound() both produce 404 with security headers + compression
    for (const mode of ['return', 'throw'] as const) {
      const h = makeHandler({
        hasLoad: true,
        mod: {
          load(ctx) {
            ctx.cookies.set('nf', mode)
            if (mode === 'throw')
              throw notFound()
            return notFound()
          },
          default() { return raw('<p>never</p>') },
        },
      })
      const res = await h(new Request('http://localhost/test', { headers: { 'accept-encoding': 'gzip' } }))
      expect(res.status).toBe(404)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-encoding')).toBe('gzip')
      expect(res.headers.getSetCookie()[0]).toContain(`nf=${mode}`)
    }

    // 2. Response returned from load() gets security headers, cookies, AND compression (when compressible)
    const loadRespHandler = makeHandler({
      hasLoad: true,
      mod: {
        load(ctx) {
          ctx.cookies.set('tok', 'abc')
          return ctx.json({ items: Array.from({ length: 40 }, (_, i) => `item-${i}`) })
        },
        default() { return raw('<p>never</p>') },
      },
    })
    const jsonRes = await loadRespHandler(new Request('http://localhost/test', { headers: { 'accept-encoding': 'zstd' } }))
    expect(jsonRes.status).toBe(200)
    expect(jsonRes.headers.get('content-encoding')).toBe('zstd')
    expect(jsonRes.headers.get('x-content-type-options')).toBe('nosniff')
    expect(jsonRes.headers.getSetCookie()[0]).toContain('tok=abc')

    // 3. Page island props filtered via clientData
    const islandHandler = makeHandler({
      hasLoad: true,
      entry: { isIsland: true, islandChunk: '/_kay/Page.js', islandChunks: ['/_kay/Page.js'] },
      mod: {
        clientData: ['publicName'],
        load() { return { publicName: 'Ada', secret: 'top-secret' } },
        default({ data }) {
          const d = data as { publicName: string }
          return raw(`<h1>${d.publicName}</h1>`)
        },
      },
    })
    const islandHtml = await (await islandHandler(new Request('http://localhost/test'))).text()
    expect(islandHtml).toContain('Ada')
    expect(islandHtml).not.toContain('top-secret')

    // 4. Sync & async errors in page and layouts route through notifyError + renderError
    const errors: unknown[] = []
    const errHandler = makeHandler({
      hasLoad: false,
      errors,
      mod: {
        async default() { throw new Error('async-page-boom') },
      },
    })
    const errRes = await errHandler(new Request('http://localhost/test'))
    expect(errRes.status).toBe(500)
    expect(await errRes.text()).toBe('ERR:async-page-boom')
    expect(errors.length).toBe(1)
  })
})
