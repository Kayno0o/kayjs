import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/base-site/src/routes'
const api = 'tests/fixtures/base-site/src/api'
const seen: Request[] = []
const recorder = new Elysia().onRequest(({ request }) => void seen.push(request))
const site = await testSite({ routes, api, base: '/blog', mcp: true, islands: false, use: [recorder], headers: { 'x-test': 'default' } })
const strict = await testSite({ routes, api, base: '/blog', trailingSlash: 'always', islands: false })
const { enter } = await import(join(import.meta.dir, 'fixtures/base-site/src/routes/index.kay')) as { enter: Action<{ name: string }, unknown> }
const { default: cookies } = await import(join(import.meta.dir, 'fixtures/base-site/src/api/cookies')) as typeof import('./fixtures/base-site/src/api/cookies')

afterAll(async () => {
  await Promise.all([site.close(), strict.close()])
})

// The request that reached the app last, or the last for a path.
const lastTo = (part: string): Request => seen.findLast(request => new URL(request.url).pathname.includes(part))!

async function echoed(call: Promise<{ body: unknown }>): Promise<Record<string, string>> {
  return (await call).body as Record<string, string>
}

describe('testSite({ headers }) reaches every method', () => {
  it('sends the default on a visit, a call\'s own header of the same name in any case winning', async () => {
    await site.visit('/home')
    expect(lastTo('/home').headers.get('x-test')).toBe('default')
    await site.visit('/home', { headers: { 'X-Test': 'own' } })
    expect(lastTo('/home').headers.get('x-test')).toBe('own')
  })

  it('sends it on a submit, a call and a refusal, a default origin never replacing the one they send', async () => {
    await site.submit(enter, { name: 'Ada' })
    expect(lastTo(enter.url).headers.get('x-test')).toBe('default')

    await expect(site.call(enter, { name: 'Ada' })).rejects.toBeDefined()
    expect(lastTo(enter.url).headers.get('x-test')).toBe('default')

    await expect(site.refusal(enter, { name: 'Ada' })).rejects.toBeDefined()
    expect(lastTo(enter.url).headers.get('x-test')).toBe('default')
  })

  it('never lets a default origin replace the one a call and a submit send', async () => {
    const foreign = await testSite({ routes, api, base: '/blog', islands: false, use: [recorder], headers: { origin: 'https://default.test' } })

    try {
      await foreign.submit(enter, { name: 'Ada' })
      expect(lastTo(enter.url).headers.get('origin')).toBe('http://localhost')
      await expect(foreign.call(enter, { name: 'Ada' })).rejects.toBeDefined()
      expect(lastTo(enter.url).headers.get('origin')).toBe('http://localhost')
      await foreign.fetch('/api/cookies/read')
      expect(lastTo('/cookies/read').headers.get('origin')).toBe('https://default.test')
    }
    finally {
      await foreign.close()
    }
  })

  it('sends it on fetch, api and a stream, and on the mcp endpoint', async () => {
    await site.fetch('/api/cookies/read')
    expect(lastTo('/cookies/read').headers.get('x-test')).toBe('default')
    expect((await echoed(site.api(cookies, '/headers')))['x-test']).toBe('default')
    expect((await echoed(site.api(cookies, '/headers', { headers: { 'X-TEST': 'own' } })))['x-test']).toBe('own')

    const stream = site.stream(cookies, '/headers-stream')

    expect((await stream.finished())[0]!['x-test']).toBe('default')

    await site.mcp.tools()
    expect(lastTo('/mcp').headers.get('x-test')).toBe('default')
    expect(lastTo('/mcp').headers.get('content-type')).toBe('application/json')
  })

  it('leaves an accept the site sets over the api\'s own', async () => {
    const wanted = await testSite({ routes, api, base: '/blog', islands: false, headers: { accept: 'text/plain' } })

    try {
      expect((await echoed(wanted.api(cookies, '/headers'))).accept).toBe('text/plain')
      expect((await echoed(site.api(cookies, '/headers'))).accept).toBe('application/json')
    }
    finally {
      await wanted.close()
    }
  })
})

describe('site.api under a base and a trailing slash', () => {
  it('reaches an API route as fetch reaches it', async () => {
    expect((await site.api(cookies, '/headers')).status).toBe(200)
    expect((await strict.api(cookies, '/headers')).status).toBe(200)
    expect((await strict.api(cookies, '/headers', { method: 'post' })).status).toBe(200)
    expect((await strict.api(cookies, '/read')).body).toBe('')
  })
})

describe('socketRefusal under a base', () => {
  it('refuses a cross-site upgrade on either site', async () => {
    expect((await site.socketRefusal(cookies, '/feed', { headers: { origin: 'https://evil.test' } })).status).toBe(403)
    expect((await strict.socketRefusal(cookies, '/feed', { headers: { origin: 'https://evil.test' } })).status).toBe(403)
  })

  it('keeps the cookie a refusal sets', async () => {
    const refused = await site.socketRefusal(cookies, '/gate')

    expect(refused.status).toBe(401)
    expect(site.cookies.get('gated')).toBe('1')
    site.cookies.delete('gated')
  })

  it('closes an accepted connection, which the server sees close, and fails naming the route', async () => {
    const before = (await site.api(cookies, '/sockets')).body as { opened: number, closed: number }

    await expect(site.socketRefusal(cookies, '/watch')).rejects.toThrow('was accepted')

    let now = before

    for (let waited = 0; now.closed === before.closed && waited < 2_000; waited += 20) {
      await Bun.sleep(20)
      now = (await site.api(cookies, '/sockets')).body as typeof now
    }

    expect(now.opened).toBe(before.opened + 1)
    expect(now.closed).toBe(before.closed + 1)
  })
})

describe('as() and the cookies kept', () => {
  it('sends the explicit cookie header with the jar\'s cookies it does not name, the explicit one winning', async () => {
    site.cookies.set('a', 'jar')
    site.cookies.set('b', 'jar')

    try {
      expect((await echoed(site.as('a=mine; c=3').api(cookies, '/headers'))).cookie).toBe('a=mine; c=3; b=jar')
      expect((await echoed(site.api(cookies, '/headers'))).cookie).toBe('a=jar; b=jar')
    }
    finally {
      site.cookies.delete('a')
      site.cookies.delete('b')
    }
  })

  it('stacks cookies by name, the newer winning, and keeps the cookie an as() gives over a jar delete', async () => {
    const stacked = site.as('a=1; b=2').as('b=3')

    expect((await echoed(stacked.api(cookies, '/headers'))).cookie).toBe('b=3; a=1')
    expect((await echoed(site.api(cookies, '/headers'))).cookie).toBeUndefined()
  })
})
