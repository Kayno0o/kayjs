import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { check, configCheckOptions } from '../src/check'
import { pages } from '../src/server'
import { probeHealth } from '../src/server/lifecycle'
import { liveLimits } from '../src/server/live'
import { remoteImages, remoteLimits, remotePatterns } from '../src/server/remote'

const ROUTES = 'tests/fixtures/production/src/routes'

describe('health.timeout', () => {
  const slow = (ms: number) => async () => {
    await Bun.sleep(ms)

    return true
  }

  it('fails a check slower than the timeout and keeps one inside it', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const tight = await pages({ routes: ROUTES, prebuilt: false, health: { check: slow(300), timeout: '100ms' } })
      const loose = await pages({ routes: ROUTES, prebuilt: false, health: { check: slow(300), timeout: 2 } })

      expect((await tight.handle(new Request('http://localhost/_kay/health'))).status).toBe(503)
      expect(logged.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining('the health check took longer than 0.1 s')])
      expect((await loose.handle(new Request('http://localhost/_kay/health'))).status).toBe(200)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('is 5 seconds when unset, and refused when it is no positive duration', async () => {
    for (const timeout of [0, -1, '5 s', Number.NaN])
      await expect(pages({ routes: ROUTES, prebuilt: false, health: { timeout } as never })).rejects.toThrow('health.timeout is')

    expect(await probeHealth({ timeout: 0 })).toBe(1)
  })

  it('makes the probe wait as long as the check may', async () => {
    const server = new Elysia().use(await pages({ routes: ROUTES, prebuilt: false, health: { path: '/up', check: slow(200), timeout: '1s' } })).listen(0)

    try {
      expect(await probeHealth({ path: '/up', timeout: '1s' }, String(server.server!.port))).toBe(0)
      expect(await probeHealth({ path: '/up', timeout: '50ms' }, String(server.server!.port))).toBe(1)
    }
    finally {
      await server.stop(true)
    }
  })

  it('is read by kay check', async () => {
    const problems = await check('tests/fixtures/production', configCheckOptions({ health: { timeout: '5 s' as never } }))

    expect(problems.map(problem => problem.message)).toContain('kay: health.timeout is \'5 s\'; it takes a positive duration, seconds or a string such as \'5m\', \'12h\' or \'30d\'')
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
    expect(await fetchRemote(`${origin}/big.jpg`)).toEqual({ status: 413, message: 'The image is over 1024 bytes' })
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
    expect(() => remoteLimits({ remoteTimeout: -1 })).toThrow('images.remoteTimeout is -1')
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
  const routes = ROUTES
  const idFrom = async (app: Awaited<ReturnType<typeof pages>>, header: string, headers: Record<string, string> = {}) => (await app.handle(new Request('http://localhost/contact', { headers }))).headers.get(header)

  it('names the header an id goes out on and comes in from a trusted proxy on', async () => {
    const renamed = await pages({ routes, prebuilt: false, proxy: { hops: 1 }, requestIdHeader: 'X-Correlation-Id' })

    expect(await idFrom(renamed, 'x-correlation-id')).toMatch(/^[\w-]{22}$/)
    expect(await idFrom(renamed, 'x-request-id')).toBeNull()
    expect(await idFrom(renamed, 'x-correlation-id', { 'x-correlation-id': 'edge-7' })).toBe('edge-7')
    expect(await idFrom(renamed, 'x-correlation-id', { 'x-request-id': 'edge-8' })).not.toBe('edge-8')

    const plain = await pages({ routes, prebuilt: false, proxy: { hops: 1 } })

    expect(await idFrom(plain, 'x-request-id', { 'x-request-id': 'edge-9' })).toBe('edge-9')
  })

  it('refuses a name that is no header', async () => {
    for (const name of ['', 'two words', 'a:b'])
      await expect(pages({ routes, prebuilt: false, requestIdHeader: name })).rejects.toThrow('requestIdHeader is')
  })
})
