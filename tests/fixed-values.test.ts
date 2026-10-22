import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { probeWait } from '../src/build/verify'
import { check, configCheckOptions } from '../src/check'
import { liveLimits, remoteLimits } from '../src/server/config-limits'
import { webpQuality } from '../src/server/image'
import { probeHealth } from '../src/server/lifecycle'
import { clientAddress, resetRequestIdHeader, trustProxy } from '../src/server/protection'
import { hostedStatus, readRedirects } from '../src/server/redirects'
import { remoteImages, remotePatterns } from '../src/server/remote'
import { securityHeaders } from '../src/server/security'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const ROUTES = 'tests/fixtures/production/src/routes'

describe('health.timeout', () => {
  const slow = (ms: number) => async () => {
    await Bun.sleep(ms)

    return true
  }

  it('fails a check slower than the timeout and keeps one inside it', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const tight = await pages({ root: 'tests/fixtures/production', prebuilt: false, health: { check: slow(300), timeout: '100ms' } })
      const loose = await pages({ root: 'tests/fixtures/production', prebuilt: false, health: { check: slow(300), timeout: '2s' } })

      expect((await tight.handle(new Request('http://localhost/_kay/health'))).status).toBe(503)
      expect(logged.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining('the health check took longer than 0.1 s')])
      expect((await loose.handle(new Request('http://localhost/_kay/health'))).status).toBe(200)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('runs the check once for the probes of a few seconds, and again after', async () => {
    let calls = 0
    let healthy = true
    const app = await pages({ root: 'tests/fixtures/production', prebuilt: false, health: { check: () => {
      calls += 1

      return healthy
    } } })
    const status = async () => (await app.handle(new Request('http://localhost/_kay/health'))).status
    const now = spyOn(Date, 'now')
    const start = Date.now()

    try {
      now.mockReturnValue(start)
      expect(await Promise.all([status(), status(), status()])).toEqual([200, 200, 200])
      healthy = false
      now.mockReturnValue(start + 2900)
      expect(await status()).toBe(200)
      expect(calls).toBe(1)
      now.mockReturnValue(start + 3000)
      expect(await status()).toBe(503)
      expect(calls).toBe(2)
    }
    finally {
      now.mockRestore()
    }
  })

  it('is 5 seconds when unset, and refused when it is no positive duration', async () => {
    for (const timeout of [0, -1, '5 s', Number.NaN, '30d'])
      await expect(pages({ root: 'tests/fixtures/production', prebuilt: false, health: { timeout } as never })).rejects.toThrow('health.timeout is')

    expect(await probeHealth({ timeout: '0s' })).toBe(1)
  })

  it('makes the build\'s --health wait follow it, 10 s at least', () => {
    expect(probeWait(undefined)).toBe(10_000)
    expect(probeWait(false)).toBe(10_000)
    expect(probeWait({ timeout: '8s' })).toBe(13_000)
    expect(probeWait({ timeout: '1s' })).toBe(10_000)
  })

  it('makes the probe wait as long as the check may', async () => {
    const serve = async () => new Elysia().use(await pages({ root: 'tests/fixtures/production', prebuilt: false, health: { path: '/up', check: slow(200), timeout: '1s' } })).listen(0)
    const [patient, hurried] = [await serve(), await serve()]

    try {
      expect(await probeHealth({ path: '/up', timeout: '1s' }, String(patient.server!.port))).toBe(0)
      expect(await probeHealth({ path: '/up', timeout: '50ms' }, String(hurried.server!.port))).toBe(1)
    }
    finally {
      await Promise.all([patient.stop(true), hurried.stop(true)])
    }
  })

  it('is read by kay check', async () => {
    const problems = await check('tests/fixtures/production', configCheckOptions({ health: { timeout: '5 s' as never } }))

    expect(problems.map(problem => problem.message)).toContain('kay: health.timeout is \'5 s\'; it takes a positive duration such as \'250ms\', \'5m\' or \'30d\'')
  })
})

describe('images.remote caps', () => {
  let cache: string
  const host = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)

      if (pathname === '/slow.jpg') {
        await Bun.sleep(500)

        return new Response('x'.repeat(10), { headers: { 'content-type': 'image/jpeg' } })
      }

      return new Response('x'.repeat(3000), { headers: { 'content-type': 'image/jpeg' } })
    },
  })
  const origin = `http://127.0.0.1:${host.port}`

  beforeAll(async () => {
    cache = await mkdtemp(join(tmpdir(), 'kay-fixed-'))
  })

  afterAll(async () => {
    await host.stop(true)
    await rm(cache, { recursive: true, force: true })
  })

  it('cuts a download off past remoteMaxSize, and gives up on a host slower than remoteTimeout', async () => {
    const limits = remoteLimits({ remoteMaxSize: '1kb', remoteTimeout: '100ms' })
    const fetchRemote = remoteImages(join(cache, 'capped'), remotePatterns([`${origin}/`]), undefined, undefined, limits)

    expect(limits).toEqual({ bytes: 1024, timeoutMs: 100 })
    // The size cap is checked under a timeout a loaded runner cannot reach, so a slow local answer is not taken for a slow host.
    const sized = remoteImages(join(cache, 'sized'), remotePatterns([`${origin}/`]), undefined, undefined, remoteLimits({ remoteMaxSize: '1kb', remoteTimeout: '10s' }))

    expect(await sized(`${origin}/big.jpg`)).toEqual({ status: 413, message: 'The image is over 1024 bytes' })
    expect(await fetchRemote(`${origin}/slow.jpg`)).toEqual({ status: 502, message: 'The host did not give the image' })
  })

  it('keeps 25 MB and 10 s when unset, and a larger cap lets the same image through', async () => {
    expect(remoteLimits(undefined)).toEqual({ bytes: 25 * 1024 * 1024, timeoutMs: 10_000 })

    const roomy = remoteImages(join(cache, 'roomy'), remotePatterns([`${origin}/`]), undefined, undefined, remoteLimits({ remoteMaxSize: '10kb' }))

    expect(await roomy(`${origin}/big.jpg`)).toMatchObject({ key: expect.any(String) })
  })

  it('refuses a size or a timeout that is not positive', () => {
    expect(() => remoteLimits({ remoteMaxSize: 0 })).toThrow('images.remoteMaxSize is 0')
    expect(() => remoteLimits({ remoteMaxSize: '20 mb' as never })).toThrow('images.remoteMaxSize is \'20 mb\'')
    expect(() => remoteLimits({ remoteTimeout: -1 as never })).toThrow('images.remoteTimeout is -1')
  })
})

describe('live limits', () => {
  it('default to 20 connections and 120 openings a minute, and refuse anything but whole numbers from 1', () => {
    expect(liveLimits(undefined)).toEqual({ connections: 20, perMinute: 120 })
    expect(liveLimits({ connections: 3 })).toEqual({ connections: 3, perMinute: 120 })

    for (const value of [0, 1.5, -2, Number.NaN, Infinity])
      expect(() => liveLimits({ connections: value })).toThrow('live.connections is')

    expect(() => liveLimits({ perMinute: 0 })).toThrow('live.perMinute is 0')
  })
})

describe('requestIdHeader', () => {
  afterEach(resetRequestIdHeader)

  const routes = ROUTES
  const idFrom = async (app: Awaited<ReturnType<typeof pages>>, header: string, headers: Record<string, string> = {}) => (await app.handle(new Request('http://localhost/contact', { headers }))).headers.get(header)

  it('names the header an id goes out on and comes in from a trusted proxy on, one name for the process', async () => {
    const plain = await pages({ routes, prebuilt: false, proxy: { hops: 1 } })

    expect(await idFrom(plain, 'x-request-id', { 'x-request-id': 'edge-9' })).toBe('edge-9')

    const renamed = await pages({ routes, prebuilt: false, proxy: { hops: 1 }, requestIdHeader: 'X-Correlation-Id' })

    expect(await idFrom(renamed, 'x-correlation-id')).toMatch(/^[\w-]{22}$/)
    expect(await idFrom(renamed, 'x-request-id')).toBeNull()
    expect(await idFrom(renamed, 'x-correlation-id', { 'x-correlation-id': 'edge-7' })).toBe('edge-7')
    expect(await idFrom(renamed, 'x-correlation-id', { 'x-request-id': 'edge-8' })).not.toBe('edge-8')
    await expect(pages({ routes, prebuilt: false, requestIdHeader: 'x-other-id' })).rejects.toThrow('a process uses one name')
    expect(await idFrom(await pages({ routes, prebuilt: false }), 'x-correlation-id')).toMatch(/^[\w-]{22}$/)
  })

  it('can be reset for apps naming another header in one process', async () => {
    const other = async (name: string) => idFrom(await pages({ routes, prebuilt: false, requestIdHeader: name }), name)

    expect(await other('x-first-id')).toMatch(/^[\w-]{22}$/)
    await expect(other('x-second-id')).rejects.toThrow('a process uses one name')
    resetRequestIdHeader()
    expect(await other('x-second-id')).toMatch(/^[\w-]{22}$/)
  })

  it('refuses a name that is no header', async () => {
    for (const name of ['', 'two words', 'a:b', 'Set-Cookie', 'content-type'])
      await expect(pages({ routes, prebuilt: false, requestIdHeader: name })).rejects.toThrow('requestIdHeader is')
  })
})

describe('redirects with a status', () => {
  it('answer 301 or 302 when asked, and keep 308 and 307 otherwise', async () => {
    const app = await pages({ root: 'tests/fixtures/production', prebuilt: false, redirects: { '/a': { to: '/contact', status: 301 }, '/b': { to: '/contact', status: 302 }, '/c': '/contact', '/d': { to: '/contact', permanent: false }, '/e': { to: '/contact', permanent: true, status: 301 }, '/f/*': { to: '/contact?x=*', status: 302 } } })
    const statusOf = async (path: string) => (await app.handle(new Request(`http://localhost${path}`))).status

    expect(await Promise.all(['/a', '/b', '/c', '/d', '/e', '/f/1'].map(statusOf))).toEqual([301, 302, 308, 307, 301, 302])
  })

  it('refuses a status kay does not answer with, or one contradicting permanent', () => {
    expect(() => readRedirects({ '/a': { to: '/b', status: 303 as never } })).toThrow('the redirect from /a has status 303')
    expect(() => readRedirects({ '/a': { to: '/b', permanent: false, status: 301 } })).toThrow('has permanent: false and status 301, which disagree')
    expect(() => readRedirects({ '/a': { to: '/b', permanent: true, status: 307 } })).toThrow('which disagree')
  })

  it('are listed by kay routes and written to _redirects as named, else as 301 and 302', () => {
    expect(hostedStatus('/a', { to: '/b', status: 302 })).toBe(302)
    expect(hostedStatus('/a', { to: '/b', status: 308 })).toBe(308)
    expect(hostedStatus('/a', '/b')).toBe(301)
    expect(hostedStatus('/a', { to: '/b', permanent: false })).toBe(302)
  })
})

describe('options that also take false', () => {
  it('reads proxy: false as no proxy, whatever the request forwards', async () => {
    const seen = async (proxy: true | false) => {
      const app = new Elysia()

      trustProxy(app, proxy)
      app.get('/', ({ request }) => clientAddress(request, undefined))

      return (await app.handle(new Request('http://localhost/', { headers: { 'x-forwarded-for': '9.9.9.9' } }))).text()
    }

    expect(await seen(true)).toBe('9.9.9.9')
    expect(await seen(false)).not.toBe('9.9.9.9')
  })

  it('reads proxy: false on an app as no proxy, a forwarded address and id both ignored', async () => {
    const app = new Elysia().use(await pages({ root: 'tests/fixtures/production', prebuilt: false, proxy: false })).get('/who', ({ request }) => clientAddress(request, undefined))
    const headers = { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '9.9.9.9', 'x-request-id': 'edge-1' }
    const who = await app.handle(new Request('http://localhost/who', { headers }))
    const page = await app.handle(new Request('http://localhost/contact', { headers }))

    expect(await who.text()).not.toBe('9.9.9.9')
    expect(page.headers.get('x-request-id')).not.toBe('edge-1')
  })

  it('reads preview: false as no preview, serving none of its routes', async () => {
    const withPreview = await pages({ root: 'tests/fixtures/production', prebuilt: false, preview: { secret: 'a'.repeat(40) } })
    const without = await pages({ root: 'tests/fixtures/production', prebuilt: false, preview: false })
    const draft = async (app: typeof without) => app.handle(new Request('http://localhost/_kay/draft', { method: 'POST' }))

    expect((await draft(withPreview)).status).not.toBe(404)
    expect((await draft(without)).status).toBe(404)
  })

  it('leaves a page without a policy when its security.csp is false, even with a report-only one', () => {
    const security = { reportOnly: { 'img-src': ['\'none\''] } }
    const headers = securityHeaders({ security }, [{ csp: false }])!

    expect(headers['content-security-policy']).toBeUndefined()
    expect(headers['content-security-policy-report-only']).toContain('img-src \'none\'')
    expect(securityHeaders({ security }, [{ csp: { 'img-src': ['https://a.example'] } }])!['content-security-policy']).toContain('https://a.example')
    expect(securityHeaders({}, [{ csp: { 'img-src': ['https://a.example'] } }, { csp: false }])!['content-security-policy']).toBeUndefined()
  })
})

describe('security.csp: false in a layout', () => {
  it('sends the pages under it no policy, and the pages beside it the site\'s', async () => {
    const root = await scratchDir('csp-false-')

    await Promise.all([
      Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(root, 'src/routes/plain/_layout.kay'), '--- server\nexport const page = { security: { csp: false } }\n---\nslot\n'),
      Bun.write(join(root, 'src/routes/plain/inner.kay'), 'h1 Inner\n'),
    ])

    const app = await pages({ routes: join(root, 'src/routes'), prebuilt: false })
    const policy = async (path: string) => (await app.handle(new Request(`http://localhost${path}`))).headers.get('content-security-policy')

    expect(await policy('/')).toContain('default-src')
    expect(await policy('/plain/inner')).toBeNull()
  })
})

describe('images.webp', () => {
  it('sets the WebP quality over images.quality, which stays the default and the cards\' alone', () => {
    expect(webpQuality(undefined)).toBeUndefined()
    expect(webpQuality({ quality: 70 })).toBe(70)
    expect(webpQuality({ webp: { quality: 75 } })).toBe(75)
    expect(webpQuality({ quality: 70, webp: { quality: 75 } })).toBe(75)
    expect(webpQuality({ quality: 70, webp: {} })).toBe(70)
  })
})

describe('one Not Found spelling', () => {
  it('answers the image route 404 as Not Found, as the pages and endpoints do', async () => {
    const app = await pages({ root: 'tests/fixtures/production', prebuilt: false })
    const text = async (path: string) => (await app.handle(new Request(`http://localhost${path}`))).text()

    expect(await text('/_kay/image?src=%2Fnone.png&w=320')).toBe('Not Found')
  })
})
