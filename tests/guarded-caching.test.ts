import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

// Reads a header and nothing else: `x-deny` refuses, `x-go` redirects.
const GUARD = 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny, redirect }) => {\n  request.headers.get(\'authorization\')\n\n  if (request.headers.has(\'x-deny\'))\n    deny(401, \'Sign in\')\n\n  if (request.headers.has(\'x-go\'))\n    redirect(\'/login\')\n})\n'
const ENDPOINT = 'export function GET({ headers, request }) {\n  if (request.headers.has(\'x-cache\'))\n    headers.set(\'cache-control\', \'public, max-age=60\')\n\n  return \'ok\'\n}\n'
const API = 'import { api } from \'kay/server\'\n\nexport default api()\n  .get(\'/\', () => ({ ok: true }))\n  .get(\'/own\', () => new Response(\'own\', { headers: { \'cache-control\': \'public, max-age=60\' } }))\n  .get(\'/text\', () => \'text\')\n  .get(\'/cased\', ({ set }) => {\n    set.headers[\'Cache-Control\'] = \'public, max-age=60\'\n\n    return \'cased\'\n  })\n  .get(\'/missing\', ({ status }) => status(404, \'none\'))\n'
const PAGE = '--- server\nif (ctx.request.headers.has(\'x-cache\')) ctx.headers.set(\'cache-control\', \'public, max-age=60\')\n---\nh1 Page\n'

describe('a guarded route is private', () => {
  let dir = ''
  const servers: Record<string, Awaited<ReturnType<typeof pages>>> = {}

  const answer = async (name: string, path: string, init: RequestInit = {}) => {
    const response = await servers[name]!.handle(new Request(`http://localhost${path}`, { redirect: 'manual', ...init }))

    return [response.status, response.headers.get('cache-control'), response.headers.get('vary')] as const
  }

  beforeAll(async () => {
    dir = await scratchDir('guarded-caching-')
    await Promise.all([
      Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(dir, 'routes/private/_guard.ts'), GUARD),
      Bun.write(join(dir, 'routes/private/index.kay'), PAGE),
      Bun.write(join(dir, 'routes/private/data.txt.ts'), ENDPOINT),
      Bun.write(join(dir, 'routes/open.txt.ts'), 'export function GET() {\n  return \'ok\'\n}\n'),
      Bun.write(join(dir, 'api/private/_guard.ts'), GUARD),
      Bun.write(join(dir, 'api/private/index.ts'), API),
      Bun.write(join(dir, 'api/seen.ts'), 'import { api, memoryStore, session } from \'kay/server\'\n\nexport default api()\n  .use(session({ secret: \'a-secret-of-at-least-32-characters-long\', store: memoryStore() }))\n  .get(\'/\', async ({ session }) => String(await session.get(\'user\') ?? \'none\'))\n'),
      Bun.write(join(dir, 'documented/_guard.ts'), GUARD),
      Bun.write(join(dir, 'documented/index.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => ({ ok: true }))\n'),
      Bun.write(join(dir, 'api/open.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => ({ ok: true }))\n'),
    ])

    const routes = 'routes'
    const api = 'api'

    servers.production = await pages({ root: dir, routes, api, prebuilt: false, security: false })
    servers.dev = await pages({ root: dir, routes, api, prebuilt: false, security: false, dev: true })
    servers.documented = await pages({ root: dir, routes, api: 'documented', prebuilt: false, security: false, openapi: { reference: true } })
    servers.mounted = await pages({ root: dir, routes, api, prebuilt: false, security: false, base: '/app' })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('marks the API document and reference page behind a guard, and their refusals', async () => {
    for (const path of ['/api/openapi.json', '/api/reference']) {
      expect(await answer('documented', path, { headers: { authorization: 'Bearer token' } })).toEqual([200, 'private, no-cache', 'cookie'])
      expect(await answer('documented', path, { headers: { 'x-deny': '1' } })).toEqual([401, 'private, no-cache', 'cookie'])
    }
  })

  describe.each([['production', ''], ['dev', ''], ['mounted', '']])('%s', (name, base) => {
    const authorized = { headers: { authorization: 'Bearer token' } }

    it('marks a page whose guard read a header', async () => {
      expect(await answer(name, `${base}/private`, authorized)).toEqual([200, 'private, no-cache', 'cookie, Save-Data'])
      expect(await answer(name, `${base}/private`)).toEqual([200, 'private, no-cache', 'cookie, Save-Data'])
    })

    it('marks the answers of a guard that refuses a page', async () => {
      expect(await answer(name, `${base}/private`, { headers: { 'x-deny': '1' } })).toEqual([401, 'private, no-cache', 'cookie'])
      expect(await answer(name, `${base}/private`, { headers: { 'x-go': '1' } })).toEqual([302, 'private, no-cache', 'cookie'])
    })

    it('marks a HEAD answer of a guarded page', async () => {
      expect(await answer(name, `${base}/private`, { method: 'HEAD', ...authorized })).toEqual([200, 'private, no-cache', 'cookie, Save-Data'])
    })

    it('keeps the caching a guarded page sets itself', async () => {
      expect((await answer(name, `${base}/private`, { headers: { 'x-cache': '1' } }))[1]).toBe('public, max-age=60')
    })

    it('marks a guarded endpoint, its refusals too, unless it sets its own caching', async () => {
      expect(await answer(name, `${base}/private/data.txt`, authorized)).toEqual([200, 'private, no-cache', 'cookie'])
      expect((await answer(name, `${base}/private/data.txt`, { headers: { 'x-deny': '1' } }))[1]).toBe('private, no-cache')
      expect((await answer(name, `${base}/private/data.txt`, { headers: { 'x-go': '1' } }))[1]).toBe('private, no-cache')
      expect((await answer(name, `${base}/private/data.txt`, { headers: { 'x-cache': '1' } }))[1]).toBe('public, max-age=60')
    })

    it('marks the answers of a guarded API route, its refusals too, unless it sets its own caching', async () => {
      expect((await answer(name, `${base}/api/private`, authorized))[1]).toBe('private, no-cache')
      expect((await answer(name, `${base}/api/private/text`, authorized))[1]).toBe('private, no-cache')
      expect((await answer(name, `${base}/api/private`, { headers: { 'x-deny': '1' } }))[1]).toBe('private, no-cache')
      expect((await answer(name, `${base}/api/private`, { headers: { 'x-go': '1' } }))[1]).toBe('private, no-cache')
      expect((await answer(name, `${base}/api/private/own`, authorized))[1]).toBe('public, max-age=60')
      expect((await answer(name, `${base}/api/private/cased`, authorized))[1]).toBe('public, max-age=60')
      expect(await answer(name, `${base}/api/private/missing`, authorized)).toEqual([404, 'private, no-cache', 'cookie'])
    })

    it('marks an API answer that read the session', async () => {
      expect(await answer(name, `${base}/api/seen`)).toEqual([200, 'private, no-cache', 'cookie'])
    })

    it('leaves a route no guard covers alone', async () => {
      expect(await answer(name, `${base}/`, authorized)).toEqual([200, null, 'Save-Data'])
      expect(await answer(name, `${base}/open.txt`, authorized)).toEqual([200, null, null])
      expect(await answer(name, `${base}/api/open`, authorized)).toEqual([200, null, null])
    })
  })
})
