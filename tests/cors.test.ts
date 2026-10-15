import { rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
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

  it('keeps Origin in the Vary of a Response reused across requests, each answer naming its own caller', async () => {
    // The route hands back one Response object, so what an answer carries is read before the next request.
    const grants: (string | null)[] = []

    for (const headers of [{ origin: APP }, { origin: 'capacitor://localhost' }, {}]) {
      const response = await site.fetch('/api/shared/reused', { headers })

      grants.push(response.headers.get('access-control-allow-origin'))
      expect(response.headers.get('vary')).toBe('Accept-Encoding, Origin')
    }

    expect(grants).toEqual([APP, 'capacitor://localhost', null])
  })

  it('answers overlapping requests for one reused Response each with its own request id and grant', async () => {
    const origins = [APP, 'capacitor://localhost', 'https://eu.shop.partner.example', undefined, APP]
    const answers = await Promise.all(origins.map(async origin => site.fetch('/api/shared/slow', origin === undefined ? {} : { headers: { origin } })))

    expect(answers.map(answer => answer.headers.get('access-control-allow-origin'))).toEqual(origins.map(origin => origin ?? null))
    expect(new Set(answers.map(answer => answer.headers.get('x-request-id'))).size).toBe(origins.length)
    expect(await Promise.all(answers.map(async answer => answer.text()))).toEqual(origins.map(() => 'reused'))
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

describe('answers of a route\'s own under a cors rule', () => {
  it('lets the module\'s rule alone grant: a route\'s own Access-Control-Allow-Origin, -Credentials and -Expose-Headers are replaced, or dropped for a caller the rule does not list', async () => {
    for (const path of ['own-grant', 'own-header', 'context-grant', 'frozen']) {
      const listed = await site.fetch(`/api/shared/${path}`, { headers: { origin: APP } })

      expect([path, listed.status, listed.headers.get('access-control-allow-origin'), listed.headers.get('access-control-allow-credentials'), listed.headers.get('access-control-expose-headers')]).toEqual([path, 200, APP, 'true', 'x-total'])
      expect(listed.headers.get('vary')).toContain('Origin')

      for (const headers of [{ origin: 'https://evil.example' }, {}]) {
        const refused = await site.fetch(`/api/shared/${path}`, { headers })

        expect([path, refused.status, refused.headers.get('access-control-allow-origin'), refused.headers.get('access-control-allow-credentials'), refused.headers.get('access-control-expose-headers')]).toEqual([path, 200, null, null, null])
        expect(refused.headers.get('vary')).toContain('Origin')
      }
    }
  })

  it('keeps the grant of a preflight a route answering every method leaves to kay, whichever module comes first', async () => {
    const open = await asked('/api/open/any', 'https://anyone.example', 'PUT')

    expect([open.status, open.headers.get('access-control-allow-origin')]).toEqual([204, '*'])

    const first = await asked('/api/a-first/any', 'https://first.example', 'PUT')

    expect([first.status, first.headers.get('access-control-allow-origin'), first.headers.get('access-control-allow-credentials')]).toEqual([204, 'https://first.example', 'true'])
    expect((await asked('/api/shared/items', APP, 'POST')).headers.get('access-control-allow-origin')).toBe(APP)
  })

  it('applies the same rule to a module opened to any origin', async () => {
    const answer = await site.fetch('/api/open/own-grant', { headers: { origin: 'https://anyone.example' } })

    expect([answer.headers.get('access-control-allow-origin'), answer.headers.get('access-control-allow-credentials'), answer.headers.get('vary')]).toEqual(['*', null, null])
  })

  it('leaves a module without a rule its own Access-Control headers, whichever modules with a rule come before it', async () => {
    const answer = await site.fetch('/api/zeta', { headers: { origin: APP } })

    expect([answer.headers.get('access-control-allow-origin'), answer.headers.get('vary')]).toEqual(['https://own.example', null])
  })

  it('answers a Response whose headers cannot be written, a redirect or a fetch() result in some runtimes, with its Vary and grant instead of a 500', async () => {
    const frozen = await site.fetch('/api/shared/frozen', { headers: { origin: APP, vary: 'x' } })

    expect(frozen.status).toBe(200)
    expect(frozen.headers.get('vary')).toBe('Accept-Encoding, Origin')
    expect(await frozen.text()).toBe('frozen')
  })

  it('answers a redirect, a fetch() result, a cookie, a non-200 status and a 404 Response each with the grant and Origin in Vary', async () => {
    for (const [path, status] of [['redirect', 302], ['upstream', 200], ['cookie', 200], ['created', 201], ['missing', 404]] as const) {
      const answer = await site.fetch(`/api/shared/${path}`, { headers: { origin: APP }, redirect: 'manual' })

      expect([path, answer.status, answer.headers.get('access-control-allow-origin'), answer.headers.get('vary')]).toEqual([path, status, APP, 'Origin'])

      const other = await site.fetch(`/api/shared/${path}`, { headers: { origin: 'https://evil.example' }, redirect: 'manual' })

      expect([path, other.status, other.headers.get('access-control-allow-origin'), other.headers.get('vary')]).toEqual([path, status, null, 'Origin'])
    }

    const cookie = await site.fetch('/api/shared/cookie', { headers: { origin: APP } })

    expect(cookie.headers.get('set-cookie')).toContain('session=abc')
  })

  it('compresses a large Response made per request, each answer naming its own caller', async () => {
    const compressed = await testSite({ routes: 'tests/fixtures/cors/src/routes', api: 'tests/fixtures/cors/src/api', compress: true })

    try {
      const grants: (string | null)[] = []

      for (const headers of [{ origin: APP }, { origin: 'capacitor://localhost' }, {}, { origin: APP }]) {
        const answer = await compressed.fetch('/api/shared/large', { headers: { ...headers, 'accept-encoding': 'br' } })

        grants.push(answer.headers.get('access-control-allow-origin'))
        expect(answer.headers.get('content-encoding')).toBe('br')
        expect(answer.headers.get('vary')).toContain('Origin')
        expect(answer.headers.get('vary')?.toLowerCase()).toContain('accept-encoding')
        expect(brotliDecompressSync(await answer.arrayBuffer()).toString()).toBe('large '.repeat(2000))
      }

      expect(grants).toEqual([APP, 'capacitor://localhost', null, APP])
    }
    finally {
      await compressed.close()
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

  it('parses a request\'s Origin once for a site, however many times it is asked, and still lets in a request cors admits later', () => {
    const request = post({ origin: 'http://evil.example' })
    const parse = spyOn(URL, 'canParse')

    try {
      expect(crossSiteRefused(request, APP)).toBe(true)
      const once = parse.mock.calls.length

      expect(crossSiteRefused(request, APP)).toBe(true)
      expect(crossSiteRefused(request, APP)).toBe(true)
      expect(parse.mock.calls.length).toBe(once)

      expect(crossSiteRefused(request, 'http://evil.example')).toBe(false)
      admitCrossSite(request)
      expect(crossSiteRefused(request, APP)).toBe(false)
    }
    finally {
      parse.mockRestore()
    }
  })
})
