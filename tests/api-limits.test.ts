import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { pages } from '../src/server'
import { testSite } from '../src/test'
import { parsingRoutes } from './elysia'
import { scratchDir } from './scratch'

const FIXTURE = 'tests/fixtures/api-limits'
const routes = `${FIXTURE}/src/routes`
const api = `${FIXTURE}/src/api`
const APP = 'https://app.example.com'
const cors = { origins: [APP], credentials: true }
const sites = {
  root: await testSite({ routes, api, islands: false, cors }),
  mounted: await testSite({ routes, api, islands: false, cors, base: '/blog', trailingSlash: 'always' }),
  dev: await testSite({ routes, api, islands: false, cors, dev: true }),
}
const bare = await testSite({ routes, api, islands: false })

afterAll(async () => {
  await Promise.all([...Object.values(sites), bare].map(async site => site.close()))
})

async function statuses(site: typeof bare, path: string, times: number, init: Parameters<typeof bare.fetch>[1] = {}) {
  const out: number[] = []

  for (let count = 0; count < times; count++)
    out.push((await site.fetch(path, init)).status)

  return out
}

describe('an app-wide cors', () => {
  const asked = async (site: typeof bare, path: string, origin: string) => site.fetch(path, { method: 'OPTIONS', headers: { 'origin': origin, 'access-control-request-method': 'POST' } })

  for (const [name, site] of Object.entries(sites)) {
    it(`is the default of a module that sets none, a module opting out or setting its own keeping theirs (${name})`, async () => {
      const plain = await asked(site, '/api/plain', APP)

      expect(plain.status).toBe(204)
      expect(plain.headers.get('access-control-allow-origin')).toBe(APP)
      expect(plain.headers.get('access-control-allow-credentials')).toBe('true')
      expect((await asked(site, '/api/plain', 'https://evil.example')).headers.get('access-control-allow-origin')).toBeNull()
      expect((await site.fetch('/api/plain', { headers: { origin: APP } })).headers.get('access-control-allow-origin')).toBe(APP)
      // `cors: false` leaves the module to its own site alone.
      expect((await asked(site, '/api/private', APP)).headers.get('access-control-allow-origin')).toBeNull()
      expect((await site.fetch('/api/private', { method: 'POST', headers: { 'origin': APP, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
      expect((await site.fetch('/api/plain', { method: 'POST', headers: { 'origin': APP, 'sec-fetch-site': 'cross-site' } })).status).toBe(200)
      expect((await asked(site, '/api/own', 'https://own.example')).headers.get('access-control-allow-origin')).toBe('https://own.example')
      expect((await asked(site, '/api/own', APP)).headers.get('access-control-allow-origin')).toBeNull()
    })
  }

  it('lets an app without it keep its modules to their own site', async () => {
    expect((await asked(bare, '/api/plain', APP)).headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses an invalid origin as the module option does', async () => {
    await expect(pages({ routes, api, prebuilt: false, security: false, cors: { origins: ['example.com'] } })).rejects.toThrow('no origin')
    await expect(pages({ routes, api, prebuilt: false, security: false, cors: { origins: '*', credentials: true } as never })).rejects.toThrow('credentials')
  })
})

describe('a rate limit on an API module', () => {
  for (const [name, site] of Object.entries(sites)) {
    it(`counts every route of the module together and answers 429 with Retry-After (${name})`, async () => {
      expect(await statuses(site, '/api/limited', 1)).toEqual([200])
      expect(await statuses(site, '/api/limited/7', 1)).toEqual([200])

      const refused = await site.fetch('/api/limited/8')

      expect(refused.status).toBe(429)
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(await refused.text()).toContain('Too many requests')
    })
  }

  it('answers a refusal with the module\'s cors grant, so the calling page can read it', async () => {
    await statuses(sites.root, '/api/limited', 2)

    const refused = await sites.root.fetch('/api/limited', { headers: { origin: APP, cookie: 'a=1' } })

    expect(refused.status).toBe(429)
    expect(refused.headers.get('access-control-allow-origin')).toBe(APP)
  })

  it('counts after the guards, so a refused caller costs the allowance of none', async () => {
    expect(await statuses(bare, '/api/guarded', 4)).toEqual([401, 401, 401, 401])
    expect(await statuses(bare, '/api/guarded', 2, { headers: { authorization: 'x' } })).toEqual([200, 429])
  })

  it('leaves Elysia parsing no cookie, query or header on a route that reads none', async () => {
    expect(parsingRoutes(await pages({ routes, api, prebuilt: false, security: false }))).toEqual([])
  })
})

describe('a body limit on one API route', () => {
  it('leaves a static sibling of a parameter route with a limit to its module\'s', async () => {
    const big = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(100) }) }

    expect((await bare.fetch('/api/routes/items/4', big)).status).toBe(413)
    expect((await bare.fetch('/api/routes/items/plain', big)).status).toBe(200)
  })
})

describe('a rate limit on one API route', () => {
  for (const [name, site] of Object.entries(sites)) {
    it(`counts the route alone, whatever its params (${name})`, async () => {
      expect(await statuses(site, '/api/routes/mine', 1)).toEqual([200])
      expect(await statuses(site, '/api/routes/open', 3)).toEqual([200, 200, 200])
      expect(await statuses(site, '/api/routes/mine', 1)).toEqual([429])
    })
  }

  it('counts a route by its pattern: one limit for every value of a param, a wildcard and an optional param', async () => {
    const post = (id: string) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })

    expect([(await bare.fetch('/api/routes/items/1', post('1'))).status, (await bare.fetch('/api/routes/items/2', post('2'))).status]).toEqual([200, 429])
    expect(await statuses(bare, '/api/routes/wild/a', 1)).toEqual([200])
    expect(await statuses(bare, '/api/routes/wild/b/c', 1)).toEqual([429])
    expect(await statuses(bare, '/api/routes/maybe', 1)).toEqual([200])
    expect(await statuses(bare, '/api/routes/maybe/2', 1)).toEqual([429])
  })

  it('counts a route answering every method under one limit', async () => {
    expect([(await bare.fetch('/api/routes/any')).status, (await bare.fetch('/api/routes/any', { method: 'POST' })).status]).toEqual([200, 429])
  })

  it('counts under the key the route gives, and the client\'s address when it gives none', async () => {
    const as = (user: string) => ({ headers: { 'x-user': user } })

    expect(await statuses(bare, '/api/routes/mine', 1, as('ada'))).toEqual([200])
    expect(await statuses(bare, '/api/routes/mine', 1, as('grace'))).toEqual([200])
    expect(await statuses(bare, '/api/routes/mine', 1, as('ada'))).toEqual([429])
    // No header: the address counts.
    expect(await statuses(bare, '/api/routes/mine', 2)).toEqual([200, 429])
  })

  it('never lifts the limit for a key that is empty or throws', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      expect(await statuses(bare, '/api/routes/empty', 2)).toEqual([200, 429])
      expect(await statuses(bare, '/api/routes/throws', 2)).toEqual([200, 429])
    }
    finally {
      warn.mockRestore()
    }
  })
})

describe('a body limit on one API route', () => {
  const body = (bytes: number) => ({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(bytes) })

  for (const [name, site] of Object.entries(sites)) {
    it(`refuses a request over it with 413 before the route reads it, the routes around it keeping the app's (${name})`, async () => {
      expect((await site.fetch('/api/routes/upload', body(16))).status).toBe(200)
      expect((await site.fetch('/api/routes/upload', body(17))).status).toBe(413)
      expect((await site.fetch('/api/routes/items/4', body(17))).status).toBe(413)
    })
  }

  it('keeps the module\'s limit for the routes that set none', async () => {
    expect((await bare.fetch('/api/plain', body(5000))).status).toBe(200)
  })

  it('counts a request refused for its size against no rate limit', async () => {
    await bare.fetch('/api/routes/items/9', body(17))
    await bare.fetch('/api/routes/items/9', body(17))

    expect((await bare.fetch('/api/routes/items/9', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
  })
})

describe('invalid route settings', () => {
  async function boot(settings: string): Promise<unknown> {
    const dir = await scratchDir('api-limits')

    await Bun.write(`${dir}/src/api/bad.ts`, `import { api } from 'kay/server'\n\nexport default api().get('/', () => 1, { detail: { ${settings} } })\n`)
    await Bun.write(`${dir}/src/routes/index.kay`, 'h1 x\n')

    return pages({ routes: `${dir}/src/routes`, api: `${dir}/src/api`, prebuilt: false, security: false })
  }

  it('refuse a body limit that is no whole number of bytes', async () => {
    await expect(boot('bodyLimit: 0')).rejects.toThrow('the bodyLimit of GET /api/bad')
  })

  it('refuse a rate limit with no whole max or a window that is no duration', async () => {
    await expect(boot('rateLimit: { max: 0, window: \'1m\' }')).rejects.toThrow('max of 0')
    await expect(boot('rateLimit: { max: 1, window: \'soon\' }')).rejects.toThrow('window')
  })

  it('refuse a rate limit whose key is no function or whose store has no hit', async () => {
    await expect(boot('rateLimit: { max: 1, window: \'1m\', key: \'ip\' as never }')).rejects.toThrow('key that is not a function')
    await expect(boot('rateLimit: { max: 1, window: \'1m\', store: {} as never }')).rejects.toThrow('store without a hit')
    await expect(boot('rateLimit: { max: 1, window: \'1m\', store: null as never }')).rejects.toThrow('store without a hit')
  })
})
