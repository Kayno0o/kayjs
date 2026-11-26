import type { Subprocess } from 'bun'
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
import { devServer } from '../src/dev/index'
import { createAppContext, getAppContext, runWithAppContext, serviceKey } from '../src/plugins/index'
import { createActionRegistry } from '../src/server/action-registry'
import { CompressionCache, compressedHtmlResponse } from '../src/server/compress'
import { createServer } from '../src/server/index'
import { makeRequestContext } from '../src/server/http'
import { handleSignals } from '../src/server/lifecycle'
import { currentRequest } from '../src/server/request-scope'
import { STREAM_TAIL_MARK, streamDocument } from '../src/server/stream'
import { createRenderContext, runWithRenderContext, Suspense } from '../src/ssr/context'
import { raw, ssrChild } from '../src/ssr/index'
import { testApp } from '../src/test/index'

const kayDir = join(import.meta.dir, '..')
const tempDirs: string[] = []

function appWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kay-3632-'))
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

describe('#3632 — 1. Context.Provider preserved across <Suspense> await and error fallbacks', () => {
  it('preserves provider values across async awaits, isolates siblings, and passes context to error fallbacks (rejection & timeout)', async () => {
    const dir = appWith({
      'src/routes/index.tsx': `
        import { createContext, Suspense, useContext } from '@kayjs/kay'
        const Theme = createContext('default')
        const Locale = createContext('en')

        async function AsyncTheme({ label, ms }: { label: string, ms: number }) {
          const before = useContext(Theme)
          await Bun.sleep(ms)
          const after = useContext(Theme)
          const loc = useContext(Locale)
          return <p data-l={label}>{before}:{after}:{loc}</p>
        }

        async function FailAsync() {
          await Bun.sleep(5)
          throw new Error('boom')
        }

        function ErrView({ err }: { err: unknown }) {
          return <p class="err">{useContext(Theme)}:{(err as Error).message}</p>
        }

        export default function Home() {
          return (
            <main>
              <Theme.Provider value="dark">
                <Locale.Provider value="fr">
                  <Suspense fallback={<p>wait-a</p>}>
                    <AsyncTheme label="a" ms={25} />
                  </Suspense>
                  <Suspense fallback={<p>wait-err</p>} error={(e) => <ErrView err={e} />}>
                    <FailAsync />
                  </Suspense>
                </Locale.Provider>
              </Theme.Provider>
              <Theme.Provider value="light">
                <Suspense fallback={<p>wait-b</p>}>
                  <AsyncTheme label="b" ms={5} />
                </Suspense>
              </Theme.Provider>
              <Suspense fallback={<p>wait-c</p>}>
                <AsyncTheme label="c" ms={10} />
              </Suspense>
            </main>
          )
        }
      `,
      'src/routes/timeout.tsx': `
        import { createContext, Suspense, useContext } from '@kayjs/kay'
        const Theme = createContext('default')
        async function Hang() {
          await new Promise(() => {})
          return <p>never</p>
        }
        function TimeoutErr() {
          return <p class="timeout-err">{useContext(Theme)}</p>
        }
        export default function TimeoutPage() {
          return (
            <Theme.Provider value="midnight">
              <Suspense fallback={<p>loading</p>} error={() => <TimeoutErr />}>
                <Hang />
              </Suspense>
            </Theme.Provider>
          )
        }
      `,
    })
    const errors: unknown[] = []
    const app = await testApp({ root: dir, streamTimeout: 40, onError: info => errors.push(info.error) })

    const html = await (await app.get('/')).text()
    expect(html).toContain('<p data-l="a">dark:dark:fr</p>')
    expect(html).toContain('<p data-l="b">light:light:en</p>')
    expect(html).toContain('<p data-l="c">default:default:en</p>')
    expect(html).toContain('<p class="err">dark:boom</p>')

    const timeoutHtml = await (await app.get('/timeout')).text()
    expect(timeoutHtml).toContain('<p class="timeout-err">midnight</p>')
    expect(errors.length).toBe(2)
  })

  it('still blocks islands inside <Suspense> from reading an outer server Context.Provider', async () => {
    const dir = appWith({
      'src/ctx.ts': `
        import { createContext } from '@kayjs/kay'
        export const Secret = createContext('none')
      `,
      'src/components/BadIsland.tsx': `
        import { signal, useContext } from '@kayjs/kay'
        import { Secret } from '../ctx'
        export function BadIsland() {
          const n = signal(0)
          const leaked = useContext(Secret)
          return <button onClick={() => n.value++}>{leaked}:{n.value}</button>
        }
      `,
      'src/routes/index.tsx': `
        import { Suspense } from '@kayjs/kay'
        import { BadIsland } from '../components/BadIsland'
        import { Secret } from '../ctx'
        async function Wrap() {
          await Bun.sleep(5)
          return <BadIsland />
        }
        export default function Home() {
          return (
            <Secret.Provider value="server-only">
              <Suspense fallback={<p>wait</p>} error={(e) => <p class="island-err">{(e as Error).message}</p>}>
                <Wrap />
              </Suspense>
            </Secret.Provider>
          )
        }
      `,
    })
    const errors: unknown[] = []
    const app = await testApp({ root: dir, onError: info => errors.push(info.error) })
    const html = await (await app.get('/')).text()
    expect(html).toContain('reads a context provided outside the island')
    expect(errors.length).toBe(1)
  })
})

describe('#3632 — 2. Nested <Region> inside <Suspense> and finishRegion()', () => {
  it('carries inTarget across <Suspense> so nested <Region>s are preserved on outer swaps and addressable by path', async () => {
    const dir = appWith({
      'src/routes/index.tsx': `
        import { Region, Suspense } from '@kayjs/kay'
        async function AsyncBody() {
          await Bun.sleep(5)
          return (
            <section>
              <h2>Loaded</h2>
              <Region name="inner" class="nested"><p>inner-content</p></Region>
            </section>
          )
        }
        export default function Home() {
          return (
            <main>
              <Region name="outer">
                <Suspense fallback={<p>loading-outer</p>}>
                  <AsyncBody />
                </Suspense>
              </Region>
            </main>
          )
        }
      `,
    })
    const app = await testApp({ root: dir })

    const outerRes = await app.get('/', { 'x-kay-region': 'outer' })
    expect(outerRes.status).toBe(200)
    expect(await outerRes.text()).toBe('<section><h2>Loaded</h2><div data-kay-region="inner" class="nested"><p>inner-content</p></div></section>')

    const innerRes = await app.get('/', { 'x-kay-region': 'outer/inner' })
    expect(innerRes.status).toBe(200)
    expect(await innerRes.text()).toBe('<p>inner-content</p>')
  })

  it('replaces nested <Suspense> fallbacks with balanced <kay-s> matching without truncating at inner </kay-s>', async () => {
    const dir = appWith({
      'src/routes/index.tsx': `
        import { Region, Suspense } from '@kayjs/kay'
        async function InnerFallbackAsync() {
          await Bun.sleep(50)
          return <span>inner-fb-resolved</span>
        }
        async function OuterAsync() {
          await Bun.sleep(5)
          return <article>OUTER-DONE</article>
        }
        export default function Home() {
          return (
            <main>
              <Region name="pane">
                <Suspense fallback={<div class="fb"><Suspense fallback={<i>inner-wait</i>}><InnerFallbackAsync /></Suspense><span class="tail">TAIL</span></div>}>
                  <OuterAsync />
                </Suspense>
              </Region>
            </main>
          )
        }
      `,
    })
    const app = await testApp({ root: dir })
    const res = await app.get('/', { 'x-kay-region': 'pane' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<article>OUTER-DONE</article>')
  })

  it('enforces streamTimeout and calls onError for rejected and timed-out boundaries in finishRegion()', async () => {
    const dir = appWith({
      'src/routes/reject.tsx': `
        import { Region, Suspense } from '@kayjs/kay'
        async function Fail() {
          await Bun.sleep(5)
          throw new Error('region-boom')
        }
        export default function RejectPage() {
          return <Region name="pane"><Suspense fallback={<p>wait</p>} error={(e) => <p class="r-err">{(e as Error).message}</p>}><Fail /></Suspense></Region>
        }
      `,
      'src/routes/hang.tsx': `
        import { Region, Suspense } from '@kayjs/kay'
        async function Hang() {
          await new Promise(() => {})
          return <p>never</p>
        }
        export default function HangPage() {
          return <Region name="pane"><Suspense fallback={<p>wait</p>} error={<p class="r-timeout">timed out</p>}><Hang /></Suspense></Region>
        }
      `,
    })
    const errors: string[] = []
    const app = await testApp({
      root: dir,
      streamTimeout: 40,
      onError: info => errors.push((info.error as Error).message),
    })

    const rejRes = await app.get('/reject', { 'x-kay-region': 'pane' })
    expect(rejRes.status).toBe(200)
    expect(await rejRes.text()).toBe('<p class="r-err">region-boom</p>')

    const hangRes = await app.get('/hang', { 'x-kay-region': 'pane' })
    expect(hangRes.status).toBe(200)
    expect(await hangRes.text()).toBe('<p class="r-timeout">timed out</p>')

    expect(errors).toEqual([
      'region-boom',
      '<Suspense> boundary 0 did not resolve within 40 ms',
    ])
  })
})

describe('#3632 — 3. <Region> HTTP semantics, Vary composition, prerendered routes, and dev reload', () => {
  it('compressedHtmlResponse appends Accept-Encoding to existing Vary with case-insensitive deduplication', () => {
    const cache = new CompressionCache()
    const bigHtml = `<html><body>${'hello world '.repeat(60)}</body></html>`
    const req = new Request('http://localhost/', { headers: { 'accept-encoding': 'zstd, gzip' } })

    const compressed = compressedHtmlResponse(bigHtml, 200, { 'content-type': 'text/html', 'vary': 'x-kay-region' }, req, cache)
    expect(compressed.headers.get('content-encoding')).toBe('zstd')
    expect(compressed.headers.get('vary')).toBe('x-kay-region, Accept-Encoding')

    const dedup = compressedHtmlResponse(bigHtml, 200, { 'content-type': 'text/html', 'Vary': 'x-kay-region, accept-encoding' }, req, cache)
    expect(dedup.headers.get('vary')).toBe('x-kay-region, accept-encoding')

    const smallUncompressed = compressedHtmlResponse('<p>hi</p>', 200, { 'content-type': 'text/html', 'vary': 'x-kay-region' }, req, cache)
    expect(smallUncompressed.headers.get('content-encoding')).toBeNull()
    expect(smallUncompressed.headers.get('vary')).toBe('x-kay-region, Accept-Encoding')
  })

  it('sets Vary: x-kay-region on full pages with <Region>, handles HEAD/400/404 cleanly, and does not bypass regions on prerendered routes', async () => {
    const dir = appWith({
      'src/routes/index.tsx': `
        import { Head, Region } from '@kayjs/kay'
        let loads = 0
        export function load() {
          loads++
          return { loads }
        }
        export default function Home({ data }: { data: { loads: number } }) {
          return (
            <main>
              <Head><title>Region Page</title></Head>
              <Region name="pane"><p>hello {data.loads} {'x'.repeat(300)}</p></Region>
            </main>
          )
        }
      `,
      'src/routes/plain.tsx': `
        export default function Plain() { return <main><p>no regions here {'y'.repeat(300)}</p></main> }
      `,
      'src/routes/pre.tsx': `
        import { Region } from '@kayjs/kay'
        export const prerender = true
        export default function Pre() {
          return <main><h1>Static Shell</h1><Region name="box"><p>region-in-prerender {'z'.repeat(300)}</p></Region></main>
        }
      `,
      'src/routes/stream.tsx': `
        import { Region, Suspense } from '@kayjs/kay'
        async function Slow() { await Bun.sleep(5); return <b>done</b> }
        export default function StreamPage() {
          return <main><Region name="pane"><Suspense fallback={<i>wait</i>}><Slow /></Suspense></Region></main>
        }
      `,
    })
    await build({ root: dir })
    const errors: unknown[] = []
    const app = await createServer({ root: dir, compress: true, onError: info => errors.push(info.error) })

    // Full page with <Region> includes both x-kay-region and Accept-Encoding in Vary
    const fullRes = await app.handle(new Request('http://localhost/', { headers: { 'accept-encoding': 'gzip' } }))
    expect(fullRes.status).toBe(200)
    const fullVary = (fullRes.headers.get('vary') ?? '').toLowerCase()
    expect(fullVary).toContain('x-kay-region')
    expect(fullVary).toContain('accept-encoding')

    // Full page WITHOUT <Region> does NOT include x-kay-region in Vary
    const plainRes = await app.handle(new Request('http://localhost/plain', { headers: { 'accept-encoding': 'gzip' } }))
    expect(plainRes.status).toBe(200)
    expect((plainRes.headers.get('vary') ?? '').toLowerCase()).not.toContain('x-kay-region')

    // Streaming page with <Region> includes Vary: x-kay-region on GET and HEAD
    const streamGet = await app.handle(new Request('http://localhost/stream'))
    expect((streamGet.headers.get('vary') ?? '').toLowerCase()).toContain('x-kay-region')
    const streamHead = await app.handle(new Request('http://localhost/stream', { method: 'HEAD' }))
    expect((streamHead.headers.get('vary') ?? '').toLowerCase()).toContain('x-kay-region')
    expect(await streamHead.text()).toBe('')

    // HEAD with x-kay-region omits body while keeping region headers
    const headRegion = await app.handle(new Request('http://localhost/', { method: 'HEAD', headers: { 'x-kay-region': 'pane' } }))
    expect(headRegion.status).toBe(200)
    expect(headRegion.headers.get('x-kay-region')).toBe('pane')
    expect(decodeURIComponent(headRegion.headers.get('x-kay-title') ?? '')).toBe('Region Page')
    expect((headRegion.headers.get('vary') ?? '').toLowerCase()).toContain('x-kay-region')
    expect(await headRegion.text()).toBe('')

    // Unknown region returns 404 without onError; empty/malformed returns 400 without onError
    const missing = await app.handle(new Request('http://localhost/', { headers: { 'x-kay-region': 'nope' } }))
    expect(missing.status).toBe(404)
    expect((missing.headers.get('vary') ?? '').toLowerCase()).toContain('x-kay-region')

    const missingHead = await app.handle(new Request('http://localhost/', { method: 'HEAD', headers: { 'x-kay-region': 'nope' } }))
    expect(missingHead.status).toBe(404)
    expect(await missingHead.text()).toBe('')

    for (const badHeader of ['', '   ', '/', 'a//b', '/pane', 'pane/']) {
      const bad = await app.handle(new Request('http://localhost/', { headers: { 'x-kay-region': badHeader } }))
      expect(bad.status).toBe(400)
      expect((bad.headers.get('vary') ?? '').toLowerCase()).toContain('x-kay-region')
    }
    const badHead = await app.handle(new Request('http://localhost/', { method: 'HEAD', headers: { 'x-kay-region': '' } }))
    expect(badHead.status).toBe(400)
    expect(await badHead.text()).toBe('')

    // Prerendered route with <Region>: full page gets Vary: x-kay-region, and region request is NOT bypassed
    const preFull = await app.handle(new Request('http://localhost/pre', { headers: { 'accept-encoding': 'gzip' } }))
    expect(preFull.status).toBe(200)
    expect((preFull.headers.get('vary') ?? '').toLowerCase()).toContain('x-kay-region')
    expect((preFull.headers.get('vary') ?? '').toLowerCase()).toContain('accept-encoding')

    const preRegion = await app.handle(new Request('http://localhost/pre', { headers: { 'x-kay-region': 'box' } }))
    expect(preRegion.status).toBe(200)
    expect(preRegion.headers.get('x-kay-region')).toBe('box')
    const preRegionBody = await preRegion.text()
    expect(preRegionBody).toStartWith('<p>region-in-prerender')
    expect(preRegionBody).not.toContain('Static Shell')

    // Also verify Bun.serve() fast route table does not bypass prerendered <Region>
    const server = app.serve(0)
    try {
      const livePreRegion = await fetch(`http://127.0.0.1:${server.port}/pre`, { headers: { 'x-kay-region': 'box' } })
      expect(livePreRegion.status).toBe(200)
      expect(livePreRegion.headers.get('x-kay-region')).toBe('box')
      expect(await livePreRegion.text()).not.toContain('Static Shell')
    }
    finally {
      server.stop(true)
      await app.dispose?.()
    }

    expect(errors).toEqual([])
  })

  it('devServer does not inject live-reload <script> into x-kay-region partial fragments', async () => {
    const dir = appWith({
      'src/routes/index.tsx': `
        import { Region } from '@kayjs/kay'
        export default function Home() {
          return <main><h1>Dev</h1><Region name="pane"><p>partial-only</p></Region></main>
        }
      `,
    })
    mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
    symlinkSync(kayDir, join(dir, 'node_modules/@kayjs/kay'), 'dir')

    const dev = await devServer({ root: dir, port: 0 })
    try {
      const fullHtml = await (await fetch(`${dev.url}/`)).text()
      expect(fullHtml).toContain('EventSource')

      const regionRes = await fetch(`${dev.url}/`, { headers: { 'x-kay-region': 'pane' } })
      expect(regionRes.status).toBe(200)
      expect(regionRes.headers.get('x-kay-region')).toBe('pane')
      const regionHtml = await regionRes.text()
      expect(regionHtml).toBe('<p>partial-only</p>')
      expect(regionHtml).not.toContain('<script>')
      expect(regionHtml).not.toContain('EventSource')
    }
    finally {
      await dev.stop()
    }
  }, 30_000)
})

describe('#3632 — 4. streamDocument() abort listener cleanup and AppContext/RequestScope on timeout', () => {
  it('removes the abort event listener when a boundary settles normally', async () => {
    const rctx = createRenderContext()
    const body = runWithRenderContext(rctx, () => {
      const a = Suspense({ fallback: raw('<i>a</i>'), children: Promise.resolve(raw('<b>A</b>')) })
      const b = Suspense({ fallback: raw('<i>b</i>'), children: Promise.resolve(raw('<b>B</b>')) })
      return ssrChild([a, b])
    })

    let added = 0
    let removed = 0
    const origAdd = AbortSignal.prototype.addEventListener
    const origRemove = AbortSignal.prototype.removeEventListener
    AbortSignal.prototype.addEventListener = function (...args: Parameters<typeof origAdd>) {
      if (args[0] === 'abort')
        added++
      return origAdd.apply(this, args)
    }
    AbortSignal.prototype.removeEventListener = function (...args: Parameters<typeof origRemove>) {
      if (args[0] === 'abort')
        removed++
      return origRemove.apply(this, args)
    }
    try {
      const stream = streamDocument(`<!DOCTYPE html><body>${body}${STREAM_TAIL_MARK}</body></html>`, rctx, 5000, () => {})
      const html = await new Response(stream).text()
      expect(html).toContain('<template data-ks="0"><b>A</b></template>')
      expect(html).toContain('<template data-ks="1"><b>B</b></template>')
      expect(added).toBe(2)
      expect(removed).toBe(2)
    }
    finally {
      AbortSignal.prototype.addEventListener = origAdd
      AbortSignal.prototype.removeEventListener = origRemove
    }
  })

  it('runs chunk.renderError and onBoundaryError inside AppContext and RequestScope on timeout', async () => {
    const TAG = serviceKey<string>('test.tag')
    const appCtx = createAppContext({
      root: '/tmp',
      outDir: '/tmp/dist',
      publicDir: '/tmp/public',
      assetPrefix: '/_kay',
      dev: false,
    })
    appCtx.provide(TAG, 'scoped-app-value')

    const actions = createActionRegistry()
    const req = new Request('http://localhost/scoped')
    const { ctx } = makeRequestContext(req, {})
    ctx.locals = { trace: 'req-42' } as typeof ctx.locals

    let seenInRenderError: { appTag: string | undefined, reqUrl: string | undefined } | undefined
    let seenInOnBoundaryError: { appTag: string | undefined, reqUrl: string | undefined } | undefined

    const rctx = createRenderContext()
    const stream = runWithAppContext(appCtx, () =>
      actions.run(ctx, () => {
        const body = runWithRenderContext(rctx, () =>
          ssrChild(Suspense({
            fallback: raw('<i>wait</i>'),
            error: () => {
              seenInRenderError = {
                appTag: getAppContext()?.inject(TAG),
                reqUrl: currentRequest()?.ctx.url.pathname,
              }
              return raw('<p class="to">timeout</p>')
            },
            children: new Promise(() => {}),
          })),
        )
        return streamDocument(`<!DOCTYPE html><body>${body}${STREAM_TAIL_MARK}</body></html>`, rctx, 25, () => {
          seenInOnBoundaryError = {
            appTag: getAppContext()?.inject(TAG),
            reqUrl: currentRequest()?.ctx.url.pathname,
          }
        })
      }),
    )

    const html = await new Response(stream).text()
    expect(html).toContain('<p class="to">timeout</p>')
    expect(seenInRenderError).toEqual({ appTag: 'scoped-app-value', reqUrl: '/scoped' })
    expect(seenInOnBoundaryError).toEqual({ appTag: 'scoped-app-value', reqUrl: '/scoped' })
  })
})

describe('#3632 — 5. Graceful shutdown drain order and re-entrancy', () => {
  it('closes streams before draining, disposes after drain, guards duplicate signals, and clears timeout on error', async () => {
    const events: string[] = []
    let resolveStop!: () => void
    const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve })
    let exitCode: number | undefined

    const mockServer = {
      stop() {
        events.push('server.stop:start')
        return stopPromise.then(() => {
          events.push('server.stop:done')
        })
      },
    } as unknown as ReturnType<Awaited<ReturnType<typeof createServer>>['serve']>

    const mockApp = {
      handle: async () => new Response('ok'),
      serve: () => mockServer,
      closeStreams: async () => {
        events.push('app.closeStreams')
      },
      dispose: async () => {
        events.push('app.dispose')
      },
    }

    const detach = handleSignals(mockApp, mockServer, {
      timeoutMs: 5000,
      exit: (code) => {
        exitCode = code
        events.push(`exit:${code}`)
      },
    })

    try {
      process.emit('SIGTERM')
      process.emit('SIGINT')
      process.emit('SIGHUP')
      await Bun.sleep(10)
      // Streams closed before drain completes, dispose has NOT run yet!
      expect(events).toEqual(['server.stop:start', 'app.closeStreams'])

      resolveStop()
      await Bun.sleep(10)
      expect(events).toEqual(['server.stop:start', 'app.closeStreams', 'server.stop:done', 'app.dispose', 'exit:0'])
      expect(exitCode).toBe(0)
    }
    finally {
      detach()
    }
  })

  it('runs dispose and clears forced timeout even when server.stop() rejects', async () => {
    const events: string[] = []
    let exitCode: number | undefined
    const origError = console.error
    console.error = () => {}

    const mockServer = {
      stop() {
        events.push('server.stop:throw')
        return Promise.reject(new Error('stop failed'))
      },
    } as unknown as ReturnType<Awaited<ReturnType<typeof createServer>>['serve']>

    const mockApp = {
      handle: async () => new Response('ok'),
      serve: () => mockServer,
      closeStreams: async () => { events.push('app.closeStreams') },
      dispose: async () => { events.push('app.dispose') },
    }

    const detach = handleSignals(mockApp, mockServer, {
      timeoutMs: 50,
      exit: (code) => {
        exitCode = code
        events.push(`exit:${code}`)
      },
    })
    try {
      process.emit('SIGTERM')
      await Bun.sleep(80)
      // Only exited once (with 1 from catch), NOT twice (forced timeout was cleared in finally!)
      expect(events).toEqual(['server.stop:throw', 'app.closeStreams', 'app.dispose', 'exit:1'])
      expect(exitCode).toBe(1)
    }
    finally {
      console.error = origError
      detach()
    }
  })

  it('keeps DB/plugin resources open during in-flight HTTP drain while immediately closing SSE streams on SIGTERM + SIGINT', async () => {
    const dir = appWith({
      'src/live.ts': `
        import { createRooms } from '@kayjs/live'
        export const rooms = createRooms<string, string>({ path: '/events', member: () => 'guest', pingMs: 0 })
      `,
      'src/routes/slow.ts': `
        import { writeFileSync } from 'node:fs'
        export async function GET(): Promise<Response> {
          writeFileSync(process.env.SLOW_STARTED!, '1')
          await Bun.sleep(250)
          const open = (globalThis as { __dbOpen?: boolean }).__dbOpen === true
          return new Response(open ? 'db-still-open' : 'db-closed-too-early')
        }
      `,
      'src/routes/index.tsx': 'export default function Home() { return <p>Home</p> }\n',
    })
    const logFile = join(dir, 'order.log')
    const startedFile = join(dir, 'slow-started')
    writeFileSync(join(dir, 'kay.config.ts'), `
      import { appendFileSync } from 'node:fs'
      import { defineConfig } from '@kayjs/kay/config'
      import { rooms } from './src/live'
      export default defineConfig({
        plugins: [
          rooms,
          {
            name: 'mock-db',
            server(api) {
              ;(globalThis as { __dbOpen?: boolean }).__dbOpen = true
              api.onShutdown(() => {
                ;(globalThis as { __dbOpen?: boolean }).__dbOpen = false
                appendFileSync(${JSON.stringify(logFile)}, 'dispose\\n')
              })
            },
          },
        ],
      })
    `)
    mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
    symlinkSync(kayDir, join(dir, 'node_modules/@kayjs/kay'))
    symlinkSync(join(kayDir, '../plugin-live'), join(dir, 'node_modules/@kayjs/live'))
    await build({ root: dir })

    const proc: Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn(
      ['bun', join(kayDir, 'src/cli/index.ts'), 'start', dir, '--port', '0'],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SLOW_STARTED: startedFile } },
    )

    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let out = ''
    let url = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done)
        throw new Error(`server exited before listening: ${out}${await new Response(proc.stderr).text()}`)
      out += decoder.decode(value)
      const m = /http:\/\/\S+:\d+/.exec(out)
      if (m !== null) {
        url = m[0]
        reader.releaseLock()
        break
      }
    }

    const sse = await fetch(`${url}/events`)
    const slow = fetch(`${url}/slow`)
    while (!existsSync(startedFile))
      await Bun.sleep(10)

    proc.kill('SIGTERM')
    proc.kill('SIGINT')

    // SSE ends immediately, while /slow finishes with DB still open!
    expect(await sse.text()).toBe('retry: 2000\n\n')
    expect(await (await slow).text()).toBe('db-still-open')
    expect(await proc.exited).toBe(0)
    expect(readFileSync(logFile, 'utf8')).toBe('dispose\n')
  }, 30_000)
})
