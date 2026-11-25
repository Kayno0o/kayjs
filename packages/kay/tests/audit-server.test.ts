import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { build } from '../src/build/index'
import { devServer } from '../src/dev/index'
import {
  CompressionCache,
  createServer,
  createServerFromEmbedded,
  definePlugin,
  getClientIp,
  isHttpsRequest,
  KAY_ISLAND_STYLE_HASH,
  KAY_STREAM_SCRIPT_HASH,
  KAY_SUSPENSE_STYLE_HASH,
  verifyOrigin,
} from '../src/server/index'
import { maybeCompressResponse } from '../src/server/compress'
import { CookieStore } from '../src/server/cookies'
import { Router } from '../src/server/router'

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

describe('client IP and forwarded headers behind a trusted proxy', () => {
  const req = (headers: Record<string, string>, url = 'http://app.example/') => new Request(url, { method: 'POST', headers })

  it.each([
    ['no proxy trusted', false, 'spoofed, 203.0.113.5', '10.0.0.1'],
    ['one proxy appending to a client-sent header', true, 'spoofed, 203.0.113.5', '203.0.113.5'],
    ['one proxy, no client header', true, '203.0.113.5', '203.0.113.5'],
    ['two proxies', 2, 'spoofed, 203.0.113.5, 198.51.100.7', '203.0.113.5'],
    ['two proxies trusted, one hop seen', 2, '203.0.113.5', '203.0.113.5'],
  ] as const)('ctx.ip with %s', (_, trustProxy, xff, expected) => {
    expect(getClientIp(req({ 'x-forwarded-for': xff }), trustProxy, '10.0.0.1')).toBe(expected)
  })

  it('reads the protocol and host the trusted proxy set, not the client', () => {
    expect(isHttpsRequest(req({ 'x-forwarded-proto': 'https, http' }), true)).toBe(false)
    expect(isHttpsRequest(req({ 'x-forwarded-proto': 'http, https' }), true)).toBe(true)
    const spoofedHost = req({ 'origin': 'https://evil.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example, app.example' })
    expect(verifyOrigin(spoofedHost, undefined, true).ok).toBe(false)
    const realHost = req({ 'origin': 'https://app.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example, app.example' })
    expect(verifyOrigin(realHost, undefined, true).ok).toBe(true)
  })
})

describe('Audit #3526 Batch 1 — Server, Security, Compression, CLI & Dev', () => {
  describe('Box 1: CSRF protection on API routes & plugin routes with per-route opt-out', () => {
    it('blocks cross-site unsafe methods on API and plugin routes, allows non-browser & opt-out routes', async () => {
      const dir = makeTemp('kay-audit-box1-')
      mkdirSync(join(dir, 'src/routes/api'), { recursive: true })

      writeFileSync(join(dir, 'src/routes/api/items.ts'), `
        import type { RequestContext } from 'kay/server'
        export function GET(ctx: RequestContext) { return ctx.json({ ok: true, method: 'GET' }) }
        export function POST(ctx: RequestContext) { return ctx.json({ ok: true, method: 'POST' }) }
        export function PUT(ctx: RequestContext) { return ctx.json({ ok: true, method: 'PUT' }) }
        export function PATCH(ctx: RequestContext) { return ctx.json({ ok: true, method: 'PATCH' }) }
        export function DELETE(ctx: RequestContext) { return ctx.json({ ok: true, method: 'DELETE' }) }
      `)

      writeFileSync(join(dir, 'src/routes/api/webhook.ts'), `
        import type { RequestContext } from 'kay/server'
        export const csrf = false
        export function POST(ctx: RequestContext) { return ctx.json({ ok: true, webhook: true }) }
      `)

      const plugin = definePlugin({
        name: 'audit-csrf-plugin',
        server(api) {
          api.route('POST', '/plugin/protected', ctx => ctx.json({ ok: true, protected: true }))
          api.route('DELETE', '/plugin/protected', ctx => ctx.json({ ok: true, deleted: true }))
          api.route('POST', '/plugin/webhook', ctx => ctx.json({ ok: true, pluginWebhook: true }), { csrf: false })
        },
      })

      await build({ root: dir, plugins: [plugin] })
      const app = await createServer({ root: dir, plugins: [plugin] })

      // Cross-site Origin blocked on API routes for POST/PUT/PATCH/DELETE
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await app.handle(new Request('http://localhost/api/items', {
          method,
          headers: { origin: 'https://evil.example' },
        }))
        expect(res.status).toBe(403)
      }

      // Cross-site Sec-Fetch-Site blocked on API route
      const sfsRes = await app.handle(new Request('http://localhost/api/items', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      }))
      expect(sfsRes.status).toBe(403)

      // Same-origin POST succeeds
      const sameOrigin = await app.handle(new Request('http://localhost/api/items', {
        method: 'POST',
        headers: { origin: 'http://localhost' },
      }))
      expect(sameOrigin.status).toBe(200)

      // Non-browser client without Origin / Sec-Fetch-Site still passes
      const cliPost = await app.handle(new Request('http://localhost/api/items', { method: 'POST' }))
      expect(cliPost.status).toBe(200)

      // GET with cross-site Origin passes
      const getCross = await app.handle(new Request('http://localhost/api/items', {
        method: 'GET',
        headers: { origin: 'https://evil.example' },
      }))
      expect(getCross.status).toBe(200)

      // File-based API route opt-out: export const csrf = false
      const webhookRes = await app.handle(new Request('http://localhost/api/webhook', {
        method: 'POST',
        headers: { origin: 'https://stripe.example', 'sec-fetch-site': 'cross-site' },
      }))
      expect(webhookRes.status).toBe(200)
      expect(await webhookRes.json()).toEqual({ ok: true, webhook: true })

      // Plugin route protected by default
      const pBlocked = await app.handle(new Request('http://localhost/plugin/protected', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }))
      expect(pBlocked.status).toBe(403)

      const pDelBlocked = await app.handle(new Request('http://localhost/plugin/protected', {
        method: 'DELETE',
        headers: { 'sec-fetch-site': 'cross-site' },
      }))
      expect(pDelBlocked.status).toBe(403)

      // Plugin route opt-out: { csrf: false }
      const pOptOut = await app.handle(new Request('http://localhost/plugin/webhook', {
        method: 'POST',
        headers: { origin: 'https://partner.example', 'sec-fetch-site': 'cross-site' },
      }))
      expect(pOptOut.status).toBe(200)
      expect(await pOptOut.json()).toEqual({ ok: true, pluginWebhook: true })
    })
  })

  describe('Box 2: Finite idleTimeout & maxRequestBodySize cap (413)', () => {
    it('returns 413 Payload Too Large when body exceeds maxRequestBodySize via Content-Length or streamed body', async () => {
      const dir = makeTemp('kay-audit-box2-')
      mkdirSync(join(dir, 'src/routes/api'), { recursive: true })
      mkdirSync(join(dir, 'src/actions'), { recursive: true })

      writeFileSync(join(dir, 'src/routes/api/upload.ts'), `
        import type { RequestContext } from 'kay/server'
        export async function POST(ctx: RequestContext) {
          const text = await ctx.request.text()
          return ctx.json({ len: text.length })
        }
      `)

      writeFileSync(join(dir, 'src/actions/echo.ts'), `
        import { action } from 'kay/server'
        const passSchema = {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate(v: unknown) { return { value: v as { msg: string } } },
          },
        }
        export const echo = action(passSchema, async (input) => ({ len: input.msg.length }))
      `)

      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { echo } from '../actions/echo'
        export default function Home() {
          return <form action={echo} method="post"><input name="msg" /></form>
        }
      `)

      const manifest = await build({ root: dir })
      const actionUrl = manifest.actions[0]!.url
      const app = await createServer({ root: dir, maxRequestBodySize: 128 })

      // Under limit succeeds
      const okRes = await app.handle(new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { 'origin': 'http://localhost', 'content-type': 'text/plain' },
        body: 'a'.repeat(64),
      }))
      expect(okRes.status).toBe(200)
      expect(await okRes.json()).toEqual({ len: 64 })

      // Over limit via Content-Length header returns 413
      const clTooBig = await app.handle(new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { 'origin': 'http://localhost', 'content-length': '9999', 'content-type': 'text/plain' },
        body: 'x',
      }))
      expect(clTooBig.status).toBe(413)

      // Over limit via streamed body without Content-Length returns 413
      const bigStream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(100))
          c.enqueue(new Uint8Array(100))
          c.close()
        },
      })
      const streamTooBig = await app.handle(new Request('http://localhost/api/upload', {
        method: 'POST',
        headers: { 'origin': 'http://localhost', 'content-type': 'application/octet-stream' },
        body: bigStream,
      }))
      expect(streamTooBig.status).toBe(413)

      // Over limit on server action returns 413
      const actionTooBig = await app.handle(new Request(`http://localhost${actionUrl}`, {
        method: 'POST',
        headers: { 'origin': 'http://localhost', 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ msg: 'z'.repeat(256) }),
      }))
      expect(actionTooBig.status).toBe(413)

      // Under serve(), Bun.serve enforces the cap itself on streamed bodies, so kay does not buffer them first
      const srv = app.serve(0)
      try {
        for (const path of ['/api/upload', actionUrl]) {
          const served = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
            method: 'POST',
            headers: { 'origin': `http://127.0.0.1:${srv.port}`, 'content-type': 'application/json' },
            body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(100)); c.enqueue(new Uint8Array(100)); c.close() } }),
            duplex: 'half',
          } as RequestInit)
          expect(served.status).toBe(413)
        }
      }
      finally {
        srv.stop(true)
      }
    })

    it('uses finite idleTimeout (no idleTimeout: 0) on Bun.serve while allowing streaming Suspense/SSE', async () => {
      const serverSrc = await Bun.file(join(import.meta.dir, '../src/server/index.ts')).text()
      const devSrc = await Bun.file(join(import.meta.dir, '../src/dev/index.ts')).text()
      expect(serverSrc).not.toContain('idleTimeout: 0')
      expect(devSrc).not.toContain('idleTimeout: 0')
    })
  })

  describe('Box 3: serve() never leaks Bun default 500 stack trace page', () => {
    it('catches throwing JSON actions and unhandled errors with safe 500 response and notifyError', async () => {
      const dir = makeTemp('kay-audit-box3-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/actions'), { recursive: true })

      writeFileSync(join(dir, 'src/actions/fail.ts'), `
        import { action } from 'kay/server'
        export const failAction = action(async () => {
          throw new Error('SECRET_DB_STACK_LEAK_12345')
        })
      `)

      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { failAction } from '../actions/fail'
        export default function Home() {
          return <form action={failAction} method="post"><button>Go</button></form>
        }
      `)

      writeFileSync(join(dir, 'src/routes/boom.tsx'), `
        export default function Boom(): never {
          throw new Error('SENSITIVE_ROUTE_TRACE_98765')
        }
      `)

      const errors: string[] = []
      const manifest = await build({ root: dir })
      const actionUrl = manifest.actions[0]!.url
      const app = await createServer({
        root: dir,
        onError(info) {
          errors.push(`${info.source}:${info.error instanceof Error ? info.error.message : String(info.error)}`)
        },
      })

      // JSON action throws -> safe JSON 500 without stack or secret message
      const jsonActRes = await app.handle(new Request(`http://localhost${actionUrl}`, {
        method: 'POST',
        headers: { 'origin': 'http://localhost', 'accept': 'application/json', 'content-type': 'application/json' },
        body: '{}',
      }))
      expect(jsonActRes.status).toBe(500)
      expect(jsonActRes.headers.get('x-content-type-options')).toBe('nosniff')
      const body = await jsonActRes.json() as { ok: boolean, error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('Internal Server Error')
      expect(JSON.stringify(body)).not.toContain('SECRET_DB_STACK_LEAK_12345')

      // Live Bun.serve() route error -> never shows Bun stack page
      const srv = app.serve(0)
      try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/boom`)
        expect(res.status).toBe(500)
        const text = await res.text()
        expect(text).toBe('Internal Server Error')
        expect(text).not.toContain('SENSITIVE_ROUTE_TRACE_98765')
        expect(text).not.toContain('Bun v')
      }
      finally {
        srv.stop(true)
      }

      expect(errors).toContain('action:SECRET_DB_STACK_LEAK_12345')
      expect(errors).toContain('route:SENSITIVE_ROUTE_TRACE_98765')
    })
  })

  describe('Box 7: Secure cookies on HTTPS, SameSite=None guard, and safe <4KB action error flash', () => {
    it('defaults Secure on HTTPS and refuses SameSite=None without Secure', () => {
      // HTTP: Secure omitted by default
      const httpStore = new CookieStore(null, false)
      httpStore.set('a', '1')
      const h1 = new Headers()
      httpStore.applyTo(h1)
      expect(h1.getSetCookie()[0]).not.toContain('Secure')

      // HTTPS: Secure added by default
      const httpsStore = new CookieStore(null, true)
      httpsStore.set('a', '1')
      const h2 = new Headers()
      httpsStore.applyTo(h2)
      expect(h2.getSetCookie()[0]).toContain('Secure')

      // SameSite=None without Secure throws
      expect(() => httpStore.set('cross', '1', { sameSite: 'none' })).toThrow()
      expect(() => httpsStore.set('cross', '1', { sameSite: 'none', secure: false })).toThrow()

      // SameSite=None with Secure succeeds
      expect(() => httpsStore.set('cross', '1', { sameSite: 'none' })).not.toThrow()
      expect(() => httpStore.set('cross', '1', { sameSite: 'none', secure: true })).not.toThrow()
    })

    it('never echoes sensitive fields in action error flash and caps flash cookie strictly under 4 KB', async () => {
      const dir = makeTemp('kay-audit-box7-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/actions'), { recursive: true })

      writeFileSync(join(dir, 'src/actions/pay.ts'), `
        import { action } from 'kay/server'
        const schema = {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate() {
              return { issues: [{ message: 'Invalid submission', path: ['email'] }] }
            },
          },
        }
        export const submitPayment = action(schema, async () => ({ paid: true }))
      `)

      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { submitPayment } from '../actions/pay'
        export default function Pay() {
          return <form action={submitPayment} method="post"><button>Pay</button></form>
        }
      `)

      const manifest = await build({ root: dir })
      const actionUrl = manifest.actions[0]!.url
      const app = await createServer({ root: dir, trustProxy: true })

      const fd = new FormData()
      fd.append('email', 'alice@example.com')
      fd.append('password', 'hunter2')
      fd.append('pin', '1234')
      fd.append('iban', 'FR7630006000011234567890189')
      fd.append('cvv', '999')
      fd.append('secret', 's3cr3t')
      fd.append('token', 'tok_abc')
      fd.append('hugeField', 'x'.repeat(5000))
      for (let i = 0; i < 20; i++)
        fd.append(`note_${i}`, `val_${i}_` + 'a'.repeat(300))

      const res = await app.handle(new Request(`https://app.example${actionUrl}`, {
        method: 'POST',
        headers: {
          origin: 'https://app.example',
          referer: 'https://app.example/',
        },
        body: fd,
      }))

      expect(res.status).toBe(303)
      const setCookie = res.headers.getSetCookie().find(c => c.startsWith('__kay_action_err='))
      expect(setCookie).toBeDefined()
      // Secure flag set on HTTPS request
      expect(setCookie!).toContain('; Secure')
      // Strictly under 4 KB
      expect(Buffer.byteLength(setCookie!, 'utf8')).toBeLessThan(4096)

      // Decode flash payload and verify sensitive fields are NEVER echoed
      const rawVal = setCookie!.split(';')[0]!.split('=').slice(1).join('=')
      const decoded = JSON.parse(decodeURIComponent(rawVal)) as { values?: Record<string, string> }
      expect(decoded.values?.email).toBe('alice@example.com')
      expect(decoded.values?.password).toBeUndefined()
      expect(decoded.values?.pin).toBeUndefined()
      expect(decoded.values?.iban).toBeUndefined()
      expect(decoded.values?.cvv).toBeUndefined()
      expect(decoded.values?.secret).toBeUndefined()
      expect(decoded.values?.token).toBeUndefined()
      expect(decoded.values?.hugeField).toBeUndefined()
    })

    it('supports explicit flashFields allowlist on action() and ignores spoofed X-Forwarded-Proto when trustProxy is false', async () => {
      const dir = makeTemp('kay-audit-box7-allow-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/actions'), { recursive: true })

      writeFileSync(join(dir, 'src/actions/signup.ts'), `
        import { action } from 'kay/server'
        const schema = {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate() {
              return { issues: [{ message: 'Bad input', path: ['email'] }] }
            },
          },
        }
        export const register = action(schema, async () => ({ ok: true }), { flashFields: ['email'] })
      `)

      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { register } from '../actions/signup'
        export default function Home() {
          return <form action={register} method="post"><button>Go</button></form>
        }
      `)

      const manifest = await build({ root: dir })
      const actionUrl = manifest.actions[0]!.url
      const app = await createServer({ root: dir }) // trustProxy defaults to false

      const fd = new FormData()
      fd.append('email', 'bob@example.com')
      fd.append('bio', 'should-not-be-flashed')
      fd.append('password', 'pw123')

      const res = await app.handle(new Request(`http://localhost${actionUrl}`, {
        method: 'POST',
        headers: {
          'origin': 'http://localhost',
          'referer': 'http://localhost/',
          'x-forwarded-proto': 'https', // ignored because trustProxy is false
        },
        body: fd,
      }))

      expect(res.status).toBe(303)
      const setCookie = res.headers.getSetCookie().find(c => c.startsWith('__kay_action_err='))!
      expect(setCookie).toBeDefined()
      expect(setCookie).not.toContain('; Secure')
      const rawVal = setCookie.split(';')[0]!.split('=').slice(1).join('=')
      const decoded = JSON.parse(decodeURIComponent(rawVal)) as { values?: Record<string, string> }
      expect(decoded.values).toEqual({ email: 'bob@example.com' })
    })
  })

  describe('Box 8: Default CSP with hashes, HSTS in prod HTTPS, Cache-Control: private on dynamic HTML, nosniff on assets/public', () => {
    it('sets default CSP (with computed hashes), HSTS in prod HTTPS, Cache-Control: private on dynamic HTML, and nosniff on assets/public', async () => {
      const dir = makeTemp('kay-audit-box8-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/components'), { recursive: true })
      mkdirSync(join(dir, 'public'), { recursive: true })

      writeFileSync(join(dir, 'public/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
      writeFileSync(join(dir, 'src/components/Counter.tsx'), `
        import { signal } from 'kay'
        export function Counter() {
          const n = signal(0)
          return <button type="button" onClick={() => n.value++}>{n.value}</button>
        }
      `)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { Counter } from '../components/Counter'
        export default function Home() { return <main><Counter /></main> }
      `)
      writeFileSync(join(dir, 'src/routes/stream.tsx'), `
        import { Suspense } from 'kay'
        async function Slow() { await Bun.sleep(5); return <p>done</p> }
        export default function Stream() { return <Suspense fallback={<p>...</p>}><Slow /></Suspense> }
      `)

      const manifest = await build({ root: dir })
      const app = await createServer({ root: dir })

      // 1. Default CSP present on island page with KAY_ISLAND_STYLE_HASH (no unsafe-inline)
      const homeRes = await app.handle(new Request('http://localhost/'))
      const homeCsp = homeRes.headers.get('content-security-policy')
      expect(homeCsp).toBeTruthy()
      expect(homeCsp!).toContain("default-src 'self'")
      expect(homeCsp!).toContain(KAY_ISLAND_STYLE_HASH)
      expect(homeCsp!).not.toContain("'unsafe-inline'")
      // Dynamic HTML has Cache-Control containing private
      expect(homeRes.headers.get('cache-control')).toContain('private')

      // 2. Default CSP on Suspense page includes KAY_SUSPENSE_STYLE_HASH + KAY_STREAM_SCRIPT_HASH
      const streamRes = await app.handle(new Request('http://localhost/stream'))
      const streamCsp = streamRes.headers.get('content-security-policy')
      expect(streamCsp).toBeTruthy()
      expect(streamCsp!).toContain(KAY_SUSPENSE_STYLE_HASH)
      expect(streamCsp!).toContain(KAY_STREAM_SCRIPT_HASH)
      expect(streamRes.headers.get('cache-control')).toContain('private')

      // 3. Assets and public files (including SVG) have X-Content-Type-Options: nosniff
      const assetRes = await app.handle(new Request(`http://localhost${manifest.runtimeScript}`))
      expect(assetRes.headers.get('x-content-type-options')).toBe('nosniff')

      const svgRes = await app.handle(new Request('http://localhost/icon.svg'))
      expect(svgRes.headers.get('x-content-type-options')).toBe('nosniff')

      // 4. HSTS emitted on HTTPS in production only
      const prevEnv = process.env.NODE_ENV
      try {
        process.env.NODE_ENV = 'development'
        const devHttps = await app.handle(new Request('https://example.com/'))
        expect(devHttps.headers.get('strict-transport-security')).toBeNull()

        process.env.NODE_ENV = 'production'
        const prodHttp = await app.handle(new Request('http://example.com/'))
        expect(prodHttp.headers.get('strict-transport-security')).toBeNull()

        const prodHttps = await app.handle(new Request('https://example.com/'))
        expect(prodHttps.headers.get('strict-transport-security')).toContain('max-age=31536000')
      }
      finally {
        if (prevEnv === undefined)
          delete process.env.NODE_ENV
        else
          process.env.NODE_ENV = prevEnv
      }

      // 5. csp: false disables default CSP
      const noCspApp = await createServer({ root: dir, security: { csp: false } })
      const noCspRes = await noCspApp.handle(new Request('http://localhost/'))
      expect(noCspRes.headers.get('content-security-policy')).toBeNull()
    })
  })

  describe('Box 9: Default hostname 127.0.0.1 for serve() and devServer()', () => {
    it('binds 127.0.0.1 by default in serve() and devServer()', async () => {
      const dir = makeTemp('kay-audit-box9-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), `export default function Home() { return <h1>Hi</h1> }`)

      await build({ root: dir })
      const app = await createServer({ root: dir })
      const srv = app.serve(0)
      try {
        expect(srv.hostname).toBe('127.0.0.1')
      }
      finally {
        srv.stop(true)
      }

      const dev = await devServer({ root: dir, port: 0 })
      try {
        expect(dev.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      }
      finally {
        dev.stop()
      }
    })
  })

  describe('Box 10: Prerendered dynamic route 404 for unlisted param & refuse encoded / in :param', () => {
    it('rejects %2f / %2F in :param segments in Router', () => {
      const r = new Router<string>()
      r.add('/posts/:slug', 'post')
      expect(r.match('/posts/hello-world')?.params).toEqual({ slug: 'hello-world' })
      expect(r.match('/posts/a%2Fb')).toBeUndefined()
      expect(r.match('/posts/a%2fb')).toBeUndefined()
      expect(r.match('/posts/..%2F..%2Fetc')).toBeUndefined()
    })

    it('returns 404 for unlisted params on prerendered dynamic routes instead of SSR fallback', async () => {
      const dir = makeTemp('kay-audit-box10-')
      mkdirSync(join(dir, 'src/routes/posts'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/posts/[slug].tsx'), `
        export const prerender = true
        export function paths() { return ['/posts/allowed'] }
        export default function Post({ params }: { params: Record<string, string> }) {
          return <article>Post: {params.slug}</article>
        }
      `)

      await build({ root: dir })
      const app = await createServer({ root: dir })

      const ok = await app.handle(new Request('http://localhost/posts/allowed'))
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('Post: allowed')

      const unlisted = await app.handle(new Request('http://localhost/posts/not-in-paths'))
      expect(unlisted.status).toBe(404)
    })
  })

  describe('Box 13: trustProxy default false & ctx.ip', () => {
    it('ignores X-Forwarded-* headers when trustProxy is false and honors them when trustProxy is true', async () => {
      // Unit check on verifyOrigin
      const spoofedReq = new Request('http://internal.local/api', {
        method: 'POST',
        headers: {
          'origin': 'https://evil.example',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'evil.example',
        },
      })
      // Default trustProxy=false -> spoofed X-Forwarded-* MUST be ignored and blocked!
      expect(verifyOrigin(spoofedReq).ok).toBe(false)
      // Explicit trustProxy=true -> forwarded origin matches
      expect(verifyOrigin(spoofedReq, undefined, true).ok).toBe(true)

      const dir = makeTemp('kay-audit-box13-')
      mkdirSync(join(dir, 'src/routes/api'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/api/who.ts'), `
        import type { RequestContext } from 'kay/server'
        export function GET(ctx: RequestContext) {
          return ctx.json({ ip: (ctx as { ip?: string }).ip ?? null })
        }
      `)

      await build({ root: dir })
      const untrustedApp = await createServer({ root: dir })
      const srv = untrustedApp.serve(0)
      try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/api/who`, {
          headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1', 'x-real-ip': '198.51.100.7' },
        })
        const json = await res.json() as { ip: string | null }
        // Must NOT trust X-Forwarded-For when trustProxy is false
        expect(json.ip).not.toBe('203.0.113.5')
        expect(json.ip).not.toBe('198.51.100.7')
        expect(json.ip).toBeTruthy()
      }
      finally {
        srv.stop(true)
      }

      // Two trusted hops (CDN then nginx): the client is the entry the outer proxy wrote, second from the right
      const trustedApp = await createServer({ root: dir, trustProxy: 2 })
      const trustedRes = await trustedApp.handle(new Request('http://localhost/api/who', {
        headers: { 'x-forwarded-for': 'spoofed, 203.0.113.5, 10.0.0.1' },
      }))
      expect(await trustedRes.json()).toEqual({ ip: '203.0.113.5' })

      const realIpRes = await trustedApp.handle(new Request('http://localhost/api/who', {
        headers: { 'x-real-ip': '198.51.100.7' },
      }))
      expect(await realIpRes.json()).toEqual({ ip: '198.51.100.7' })
    })
  })

  describe('Box 41: Precompressed asset sidecars + streaming/206/no-transform/weak ETag', () => {
    it('serves precompressed .br / .gz asset sidecars directly without recompressing', async () => {
      const payload = new TextEncoder().encode('console.log("precompressed asset test");\n'.repeat(30))
      const brBytes = new Uint8Array(brotliCompressSync(payload))
      const gzBytes = new Uint8Array(gzipSync(payload))

      const app = await createServerFromEmbedded({
        manifest: {
          runtimeScript: undefined,
          styles: [],
          routes: [],
          actions: [],
          islands: {},
          assets: ['app-abc.js'],
          publicFiles: [],
        },
        modules: {},
        assets: {
          'app-abc.js': payload,
          'app-abc.js.br': brBytes,
          'app-abc.js.gz': gzBytes,
        },
        prerendered: {},
      })

      const brRes = await app.handle(new Request('http://localhost/_kay/app-abc.js', {
        headers: { 'accept-encoding': 'br, gzip' },
      }))
      expect(brRes.status).toBe(200)
      expect(brRes.headers.get('content-encoding')).toBe('br')
      expect(brRes.headers.get('vary')).toContain('Accept-Encoding')
      expect(new Uint8Array(await brRes.arrayBuffer())).toEqual(brBytes)

      const gzRes = await app.handle(new Request('http://localhost/_kay/app-abc.js', {
        headers: { 'accept-encoding': 'gzip' },
      }))
      expect(gzRes.status).toBe(200)
      expect(gzRes.headers.get('content-encoding')).toBe('gzip')
      expect(new Uint8Array(await gzRes.arrayBuffer())).toEqual(gzBytes)

      // Disk sidecar check via createServer()
      const dir = makeTemp('kay-audit-box41-disk-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/components'), { recursive: true })
      writeFileSync(join(dir, 'src/components/Btn.tsx'), `
        import { signal } from 'kay'
        export function Btn() { const n = signal(0); return <button onClick={() => n.value++}>{n.value}</button> }
      `)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { Btn } from '../components/Btn'
        export default function Home() { return <Btn /> }
      `)
      const manifest = await build({ root: dir })
      const relAsset = manifest.assets.find(a => a.endsWith('.js'))!
      const absAsset = join(dir, 'dist/client', relAsset)
      const customBr = new Uint8Array(brotliCompressSync(new TextEncoder().encode('// disk-br-sentinel')))
      writeFileSync(`${absAsset}.br`, customBr)
      const diskApp = await createServer({ root: dir })
      const diskBrRes = await diskApp.handle(new Request(`http://localhost/_kay/${relAsset}`, {
        headers: { 'accept-encoding': 'br, gzip' },
      }))
      expect(diskBrRes.status).toBe(200)
      expect(diskBrRes.headers.get('content-encoding')).toBe('br')
      expect(new Uint8Array(await diskBrRes.arrayBuffer())).toEqual(customBr)
    })

    it('skips 206, Cache-Control: no-transform, and streaming bodies without Content-Length; weakens strong ETag', async () => {
      const cache = new CompressionCache()
      const req = new Request('http://localhost/data', { headers: { 'accept-encoding': 'gzip' } })
      const big = 'hello world '.repeat(100)

      // 1. 206 Partial Content is skipped
      const res206 = new Response(big, { status: 206, headers: { 'content-type': 'text/plain' } })
      const out206 = await maybeCompressResponse(res206, req, cache)
      expect(out206.headers.get('content-encoding')).toBeNull()

      // 2. Cache-Control: no-transform is skipped
      const resNoTrans = new Response(big, {
        status: 200,
        headers: { 'content-type': 'text/plain', 'cache-control': 'public, no-transform' },
      })
      const outNoTrans = await maybeCompressResponse(resNoTrans, req, cache)
      expect(outNoTrans.headers.get('content-encoding')).toBeNull()

      // 3. Streaming ReadableStream without Content-Length is NOT buffered (does not hang on open stream!)
      let ctrl!: ReadableStreamDefaultController<Uint8Array>
      const openStream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c
          c.enqueue(new TextEncoder().encode('chunk-1\n'))
        },
      })
      const resStream = new Response(openStream, { status: 200, headers: { 'content-type': 'text/plain' } })
      const outStream = await Promise.race([
        maybeCompressResponse(resStream, req, cache),
        Bun.sleep(200).then(() => 'TIMED_OUT' as const),
      ])
      expect(outStream).not.toBe('TIMED_OUT')
      expect((outStream as Response).headers.get('content-encoding')).toBeNull()
      ctrl.close()

      // 4. Strong ETag becomes weak ETag when compressed
      const resEtag = new Response(big, {
        status: 200,
        headers: { 'content-type': 'text/plain', 'etag': '"abc123"' },
      })
      const outEtag = await maybeCompressResponse(resEtag, req, cache)
      expect(outEtag.headers.get('content-encoding')).toBe('gzip')
      expect(outEtag.headers.get('etag')).toBe('W/"abc123"')
    })
  })
})

describe('streamed Suspense boundaries', () => {
  async function streamApp(page: string, options: { streamTimeout?: number, plugins?: ReturnType<typeof definePlugin>[] } = {}) {
    const dir = makeTemp('kay-stream-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), page)
    await build({ root: dir })
    const errors: unknown[] = []
    const app = await createServer({ root: dir, onError: info => errors.push(info.error), ...options })
    return { errors, page: async () => (await app.handle(new Request('http://localhost/'))).text() }
  }

  it('renders a rejected boundary as its error template, completes the page and reports the error', async () => {
    const { errors, page } = await streamApp(`
      import { Suspense } from 'kay'
      async function Boom() { await Bun.sleep(1); throw new Error('stats down') }
      async function Bang() { await Bun.sleep(1); throw new Error('feed down') }
      export default function Home() {
        return <main>
          <Suspense fallback={<p>a</p>} error={<p class="err">failed</p>}><Boom /></Suspense>
          <Suspense fallback={<p>b</p>} error={(e) => <p class="err">{e.message}</p>}><Bang /></Suspense>
          <Suspense fallback={<p>c</p>}><Boom /></Suspense>
        </main>
      }
    `)
    const html = await page()
    expect(html).toContain('<template data-ks="0"><p class="err">failed</p></template>')
    expect(html).toContain('<template data-ks="1"><p class="err">feed down</p></template>')
    expect(html).toContain('<template data-ks="2"></template>')
    expect(html.endsWith('</html>')).toBe(true)
    expect(errors.map(e => (e as Error).message).sort()).toEqual(['feed down', 'stats down', 'stats down'])
  })

  it('flushes a boundary rendered by a boundary that resolved', async () => {
    const { page } = await streamApp(`
      import { Suspense } from 'kay'
      async function Inner() { await Bun.sleep(1); return <b>inner</b> }
      async function Outer() { await Bun.sleep(1); return <div><Suspense fallback={<i>wait</i>}><Inner /></Suspense></div> }
      export default function Home() { return <main><Suspense fallback={<p>...</p>}><Outer /></Suspense></main> }
    `)
    const html = await page()
    expect(html).toContain('<template data-ks="0"><div><kay-s id="k-s-1"><i>wait</i></kay-s></div></template>')
    expect(html).toContain('<template data-ks="1"><b>inner</b></template>')
    expect(html.endsWith('</html>')).toBe(true)
  })

  it('ends the response with the error template once a boundary exceeds streamTimeout', async () => {
    const { errors, page } = await streamApp(`
      import { Suspense } from 'kay'
      async function Hang() { await new Promise(() => {}); return <p>never</p> }
      export default function Home() { return <main><Suspense fallback={<p>...</p>} error={<p>slow</p>}><Hang /></Suspense></main> }
    `, { streamTimeout: 30 })
    const html = await page()
    expect(html).toContain('<template data-ks="0"><p>slow</p></template>')
    expect(html.endsWith('</html>')).toBe(true)
    expect((errors[0] as Error).message).toBe('<Suspense> boundary 0 did not resolve within 30 ms')
  })

  it('runs plugin HTML transforms on the shell and initial body of a streamed page', async () => {
    const tag = definePlugin({ name: 'tag', transformHtml: html => html.replace('<main>', '<main data-tagged>').replace('</head>', '<meta name="t"></head>') })
    const { page } = await streamApp(`
      import { Suspense } from 'kay'
      async function Slow() { await Bun.sleep(1); return <p>done</p> }
      export default function Home() { return <main><Suspense fallback={<p>...</p>}><Slow /></Suspense></main> }
    `, { plugins: [tag] })
    const html = await page()
    expect(html).toContain('<meta name="t"></head>')
    expect(html).toContain('<main data-tagged>')
    expect(html).toContain('<template data-ks="0"><p>done</p></template>')
    expect(html.endsWith('</html>')).toBe(true)
  })
})
