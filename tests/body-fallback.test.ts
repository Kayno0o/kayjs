import type { AnyElysia } from 'elysia'
import type { KayExtension } from '../src/config'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { crossOriginPaths } from '../src/server/cors'
import { memoryJobs } from '../src/server/queue'
import { cleanUpAfterFile } from './job-stores'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

cleanUpAfterFile()

const MB = 1024 * 1024
const reached: string[] = []
const allow = () => undefined

function reach(name: string) {
  return () => {
    reached.push(name)

    return 'ok'
  }
}

function plugin(): AnyElysia {
  return new Elysia()
    .post('/auth/token', reach('post token'))
    .put('/auth/token', reach('put token'))
    .patch('/auth/token', reach('patch token'))
    .delete('/auth/token', reach('delete token'))
    .post('/auth/upload', reach('upload'))
}

async function app(options: { base?: string, trailingSlash?: 'always' | 'never', maxSize?: string, maxSizes?: Record<string, number | string>, extension?: Partial<KayExtension> } = {}) {
  const dir = await scratchDir('body-fallback-')
  const { extension, ...rest } = options

  await Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n')

  return pages({ root: dir, routes: 'routes', prebuilt: false, security: false, dev: false, jobs: { guard: allow }, store: { jobs: memoryJobs() }, extensions: [{ name: 'fake-auth', server: plugin(), ...extension }], ...rest } as Parameters<typeof pages>[0])
}

const post = async (site: Awaited<ReturnType<typeof app>>, path: string, body: BodyInit, method = 'POST') => site.handle(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/octet-stream' }, body }))
const big = 'x'.repeat(2 * MB)

function chunked(total: number): ReadableStream<Uint8Array> {
  let sent = 0

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total)
        return controller.close()

      sent += 65_536
      controller.enqueue(new Uint8Array(65_536))
    },
  })
}

const stream = async (site: Awaited<ReturnType<typeof app>>, path: string, total: number) => site.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: chunked(total), duplex: 'half' } as RequestInit))

describe('a route no action, API module or extension limit covers', () => {
  it('refuses a body over the app-wide limit with 413, whatever the method, before the route runs', async () => {
    const site = await app()

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect((await post(site, '/auth/token', big, method)).status).toBe(413)

    expect(reached).toEqual([])
  })

  it('takes a body within the limit', async () => {
    const site = await app()

    expect((await post(site, '/auth/token', 'x'.repeat(1000))).status).toBe(200)
    expect(reached).toEqual(['post token'])
  })

  it('counts a chunked body, which sends no Content-Length', async () => {
    const site = await app()

    expect((await stream(site, '/auth/token', 2 * MB)).status).toBe(413)
    expect((await stream(site, '/auth/token', 4096)).status).toBe(200)
  })

  it('refuses a lying Content-Length without reading the body', async () => {
    const site = await app()
    const response = await site.handle(new Request('http://localhost/auth/token', { method: 'POST', headers: { 'content-length': String(200 * MB) }, body: 'x' }))

    expect(response.status).toBe(413)
  })

  it('reaches the route through a trailing slash, and under a base', async () => {
    const site = await app({ trailingSlash: 'always' })
    const mounted = await app({ base: '/blog' })

    expect((await post(site, '/auth/token/', big)).status).toBe(413)
    // The proxy strips the base before the request reaches the server.
    expect((await post(mounted, '/auth/token', big)).status).toBe(413)
    expect((await post(mounted, '/auth/token', 'x')).status).toBe(200)
  })

  it('follows the app\'s maxSize', async () => {
    const site = await app({ maxSize: '4mb' })

    expect((await post(site, '/auth/token', big)).status).toBe(200)
    expect((await post(site, '/auth/token', 'x'.repeat(5 * MB))).status).toBe(413)
  })

  it('refuses the jobs page\'s posts, before its guard', async () => {
    const site = await app()

    expect((await post(site, '/_kay/jobs/delete', big)).status).toBe(413)
    expect((await post(site, '/_kay/jobs/retry', big)).status).toBe(413)
  })
})

describe('the app\'s own limits by path', () => {
  it('raises the limit for a route of its own: with a Content-Length, chunked, with a trailing slash and under a base', async () => {
    for (const options of [{}, { trailingSlash: 'always' as const }, { base: '/blog' }]) {
      const site = await app({ ...options, maxSizes: { '/auth/upload': '8mb' } })

      expect((await post(site, '/auth/upload', big)).status).toBe(200)
      expect((await post(site, '/auth/upload/', big)).status).toBe(200)
      expect((await stream(site, '/auth/upload', 2 * MB)).status).toBe(200)
      expect((await stream(site, '/auth/upload', 9 * MB)).status).toBe(413)
      expect((await post(site, '/auth/upload', 'x'.repeat(9 * MB))).status).toBe(413)
      expect((await site.handle(new Request('http://localhost/auth/upload', { method: 'POST', headers: { 'content-length': String(200 * MB) }, body: 'x' }))).status).toBe(413)
      expect((await post(site, '/auth/token', big)).status).toBe(413)
    }
  })

  it('lowers it, wins over an extension for one path, and stops the boot for a bad entry', async () => {
    const site = await app({ maxSizes: { '/auth/token': 100, '/auth/upload': '1kb' }, extension: { maxSize: { '/auth/upload': '8mb' } } })

    expect((await post(site, '/auth/token', 'x'.repeat(101))).status).toBe(413)
    expect((await post(site, '/auth/upload', 'x'.repeat(2000))).status).toBe(413)
    await expect(app({ maxSizes: { 'auth/token': '1mb' } })).rejects.toThrow('does not start with a slash')
    await expect(app({ maxSizes: { '/auth/token': 0 } })).rejects.toThrow('maxSize')
  })
})

describe('an extension\'s own limit', () => {
  it('raises the limit for its route and what is under it, the rest keeping the app\'s', async () => {
    const site = await app({ extension: { maxSize: { '/auth/upload': '8mb' } } })

    expect((await post(site, '/auth/upload', big)).status).toBe(200)
    expect((await post(site, '/auth/upload', 'x'.repeat(9 * MB))).status).toBe(413)
    expect((await post(site, '/auth/token', big)).status).toBe(413)
    expect((await stream(site, '/auth/upload', 2 * MB)).status).toBe(200)
  })

  it('can lower it, under a base too', async () => {
    const site = await app({ base: '/blog', extension: { maxSize: { '/auth/token': 100 } } })

    expect((await post(site, '/auth/token', 'x'.repeat(101))).status).toBe(413)
    expect((await post(site, '/auth/token', 'x'.repeat(100))).status).toBe(200)
  })

  it('stops the boot for a limit that is no size', async () => {
    await expect(app({ extension: { maxSize: { '/auth/token': 0 } } })).rejects.toThrow('maxSize')
    await expect(app({ extension: { maxSize: { 'auth/token': '1mb' } } })).rejects.toThrow('does not start with a slash')
  })
})

describe('a cross-origin route of an extension', () => {
  const ORIGIN = 'https://client.example'
  const crossOrigin = (maxSize?: KayExtension['maxSize']) => {
    const server = plugin()

    crossOriginPaths(server, ['/auth'], { origins: '*' })

    return { server, ...maxSize && { maxSize } }
  }

  const tooBig = async (site: Awaited<ReturnType<typeof app>>, path: string) => site.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'origin': ORIGIN }, body: big }))

  it('answers a body over the limit with the grant its own answers carry, only for the paths it named', async () => {
    const site = await app({ extension: crossOrigin() })
    const refused = await tooBig(site, '/auth/token')

    expect(refused.status).toBe(413)
    expect(refused.headers.get('access-control-allow-origin')).toBe('*')
    expect(await refused.text()).toBe('Payload Too Large')
    expect((await tooBig(await app(), '/auth/token')).headers.get('access-control-allow-origin')).toBeNull()
  })

  it('keeps the grant on a limit of its own, the app\'s maxSizes or the extension\'s maxSize', async () => {
    for (const options of [{ extension: crossOrigin({ '/auth/token': 100 }) }, { extension: crossOrigin(), maxSizes: { '/auth/token': 100 } }]) {
      const refused = await tooBig(await app(options), '/auth/token')

      expect(refused.status).toBe(413)
      expect(refused.headers.get('access-control-allow-origin')).toBe('*')
    }
  })
})
