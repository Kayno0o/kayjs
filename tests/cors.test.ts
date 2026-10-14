import { rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { check } from '../src/check'
import { admitCrossSite, crossSiteRefused } from '../src/server/actions'
import { corsRule } from '../src/server/cors'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

const APP = 'https://app.example.com'
const site = await testSite({ routes: 'tests/fixtures/cors/src/routes', api: 'tests/fixtures/cors/src/api' })

afterAll(async () => {
  await site.close()
})

function upgrade(path: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, { headers: { 'upgrade': 'websocket', 'connection': 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', 'sec-fetch-site': 'cross-site', ...headers } })
}

async function asked(path: string, origin: string, method: string, headers: Record<string, string> = {}): Promise<Response> {
  return site.fetch(path, { method: 'OPTIONS', headers: { 'origin': origin, 'access-control-request-method': method, ...headers } })
}

async function posted(path: string, headers: Record<string, string>, body: unknown = { name: 'pen' }): Promise<Response> {
  return site.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', ...headers }, body: JSON.stringify(body) })
}

describe('an API module opening its routes to other sites', () => {
  it('answers a preflight from an origin it lists with its methods, the headers asked, and how long to keep the answer', async () => {
    const preflight = await asked('/api/shared/items/1', APP, 'DELETE', { 'access-control-request-headers': 'content-type, x-trace' })

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(APP)
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true')
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE')
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type, x-trace')
    expect(preflight.headers.get('access-control-max-age')).toBe('3600')
    expect(preflight.headers.get('vary')).toContain('Origin')
    expect(preflight.headers.get('vary')).toContain('Access-Control-Request-Headers')
    expect((await asked('/api/shared/items', 'https://eu.shop.partner.example', 'POST')).headers.get('access-control-allow-origin')).toBe('https://eu.shop.partner.example')
    expect((await asked('/api/shared/items', 'capacitor://localhost', 'POST')).headers.get('access-control-allow-origin')).toBe('capacitor://localhost')
  })

  it('grants nothing to an origin it does not list, a lookalike of a listed subdomain included', async () => {
    for (const origin of ['https://evil.example', 'https://partner.example', 'https://evilpartner.example', 'http://app.example.com']) {
      const preflight = await asked('/api/shared/items', origin, 'POST')

      expect([origin, preflight.headers.get('access-control-allow-origin'), preflight.headers.get('access-control-allow-methods')]).toEqual([origin, null, null])
      expect(preflight.headers.get('vary')).toContain('Origin')
    }
  })

  it('lets a listed origin\'s requests through with their cookies, its answers naming it and showing the headers it exposes', async () => {
    const read = await site.fetch('/api/shared/items', { headers: { origin: APP, cookie: 'session=1' } })

    expect(read.headers.get('access-control-allow-origin')).toBe(APP)
    expect(read.headers.get('access-control-allow-credentials')).toBe('true')
    expect(read.headers.get('access-control-expose-headers')).toBe('x-total')
    expect(read.headers.get('vary')).toContain('Origin')

    const added = await posted('/api/shared/items', { origin: APP, cookie: 'session=1' })

    expect(added.status).toBe(200)
    expect(await added.json()).toEqual({ added: 'pen' })
    expect((await posted('/api/shared/items', { origin: 'https://evil.example' })).status).toBe(403)
  })

  it('lets the calling page read why its input was refused: a body the schema refuses, one that does not parse, one over the limit', async () => {
    const refused = [
      await posted('/api/shared/items', { origin: APP }, { name: 1 }),
      await site.fetch('/api/shared/items', { method: 'POST', headers: { 'content-type': 'application/json', 'origin': APP }, body: '{"name":' }),
      await posted('/api/shared/items', { origin: APP }, { name: 'x'.repeat(512) }),
    ]

    expect(refused.map(response => response.status)).toEqual([422, 400, 413])

    for (const response of refused) {
      expect(response.headers.get('access-control-allow-origin')).toBe(APP)
      expect(response.headers.get('vary')).toContain('Origin')
    }
  })

  it('keeps Origin in a Vary the route sets itself', async () => {
    expect((await site.fetch('/api/shared/greeting', { headers: { origin: APP } })).headers.get('vary')).toBe('Accept-Language, Origin')
    expect((await site.fetch('/api/shared/built', { headers: { origin: APP } })).headers.get('vary')).toContain('Accept-Encoding, Origin')
  })

  it('opens its websockets to the origins it lists only', async () => {
    expect((await site.handle(upgrade('/api/shared/live', { origin: APP }))).status).not.toBe(403)
    expect((await site.handle(upgrade('/api/shared/live', { origin: 'https://evil.example' }))).status).toBe(403)
  })

  it('varies by origin even for a request naming none, so a cache never hands a listed site an answer made for another', async () => {
    const plain = await site.fetch('/api/shared/items')

    expect(plain.headers.get('vary')).toContain('Origin')
    expect(plain.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('opened to any origin, answers with * and takes no cookies from another site', async () => {
    const preflight = await asked('/api/open', 'https://anyone.example', 'POST', { 'access-control-request-headers': 'x-trace' })

    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull()
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type')
    expect(preflight.headers.get('access-control-max-age')).toBe('600')
    expect(preflight.headers.get('vary')).toBeNull()
    expect((await asked('/api/open/any', 'https://anyone.example', 'PUT')).headers.get('access-control-allow-methods')).toBe('GET, POST, HEAD, PUT, PATCH, DELETE')

    const sent = await posted('/api/open', { origin: 'https://anyone.example' })

    expect(sent.status).toBe(200)
    expect(sent.headers.get('access-control-allow-origin')).toBe('*')
    expect((await posted('/api/open', { origin: 'https://anyone.example', cookie: 'session=1' })).status).toBe(403)
  })

  it('leaves a module that does not open itself refusing other sites\' posts, with no preflight answered', async () => {
    expect((await posted('/api/closed', { origin: APP })).status).toBe(403)
    expect((await asked('/api/closed', APP, 'POST')).headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers a preflight without running the guards, which still refuse the request itself, readably by the calling page', async () => {
    expect((await asked('/api/guarded', APP, 'POST')).status).toBe(204)

    const refused = await posted('/api/guarded', { origin: APP })

    expect(refused.status).toBe(401)
    expect(refused.headers.get('access-control-allow-origin')).toBe(APP)
    expect((await posted('/api/guarded', { origin: APP, authorization: 'Bearer 1' })).status).toBe(200)
  })

  it('refuses an origin that is none, and cookies for any origin', () => {
    expect(() => corsRule({ origins: ['https://app.example.com/path'] })).toThrow('which is no origin')
    expect(() => corsRule({ origins: ['app.example.com'] })).toThrow('which is no origin')
    // @ts-expect-error cookies go to listed origins only
    expect(() => corsRule({ origins: '*', credentials: true })).toThrow('never \'*\'')
  })

  it('has kay check report cookies for any origin', async () => {
    const dir = await scratchDir('cors-')

    try {
      await Promise.all(Object.entries({
        'package.json': JSON.stringify({ name: 'app' }),
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
        'src/routes/index.kay': 'h1 Home\n',
        'src/api/open.ts': 'import { api } from \'kay/server\'\n\nexport default api({ cors: { origins: \'*\', credentials: true } }).get(\'/\', () => ({ open: true }))\n',
      }).map(async ([path, content]) => Bun.write(join(dir, path), content)))

      expect((await check(dir)).map(({ file, line, message }) => [relative(dir, file), line, message])).toEqual([['src/api/open.ts', 3, 'Type \'true\' is not assignable to type \'false\'.']])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('crossSiteRefused', () => {
  const post = (headers: Record<string, string>) => new Request('http://app.test/x', { method: 'POST', headers })

  it('refuses a cross-site POST or upgrade, not a safe method, a missing Origin or the app\'s own host', () => {
    expect(crossSiteRefused(post({ origin: 'http://evil.example' }))).toBe(true)
    expect(crossSiteRefused(new Request('http://app.test/x', { headers: { origin: 'http://evil.example', upgrade: 'websocket' } }))).toBe(true)
    expect(crossSiteRefused(new Request('http://app.test/x', { headers: { origin: 'http://evil.example' } }))).toBe(false)
    expect(crossSiteRefused(post({}))).toBe(false)
    expect(crossSiteRefused(post({ origin: 'http://app.test' }))).toBe(false)
    expect(crossSiteRefused(post({ origin: 'https://public.example' }), 'https://public.example')).toBe(false)
  })

  it('leaves a request an API module\'s cors let in', () => {
    const request = post({ origin: 'http://other.example' })

    admitCrossSite(request)
    expect(crossSiteRefused(request)).toBe(false)
  })
})
