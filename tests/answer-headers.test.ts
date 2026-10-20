import type { ClientBuild } from '../src/server/client'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { files, memoryFiles, pages } from '../src/server'
import { serveBuildFiles } from '../src/server/build-files'
import { fixtureCopy, scratchDir } from './scratch'

const ORIGIN = 'http://localhost'
const REQUEST_ID = /^[\w-]{22}$/
// What every answer carries, whichever route made it; the policy is the same string everywhere, checked against the page's.
const SECURITY = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',
  'x-request-id': '<id>',
  'x-kay-build': '<build>',
}
const IMMUTABLE = 'public, max-age=31536000, immutable'
const JSON_TYPE = 'application/json;charset=utf-8'

// The headers of an answer, its request id and cookie values masked, as one object.
function shape(response: Response): Record<string, string> {
  const seen: Record<string, string> = {}

  for (const [name, value] of response.headers) {
    if (name === 'x-request-id')
      expect(value).toMatch(REQUEST_ID)

    if (name === 'x-request-id')
      seen[name] = '<id>'
    else if (name === 'x-kay-build')
      seen[name] = '<build>'
    else
      seen[name] = name === 'set-cookie' ? value.replace(/=[^;]*/g, '=<value>') : value
  }

  return seen
}

describe('the headers of every kind of answer', () => {
  let app: Awaited<ReturnType<typeof pages>>
  let key: string
  let asset: string
  let action: string
  let page: string

  beforeAll(async () => {
    const dir = await fixtureCopy('answers')

    app = await pages({ routes: `${dir}/src/routes`, api: `${dir}/src/api`, prebuilt: false, log: false, compress: true, storage: memoryFiles() })
    key = await files.put(new File([new Uint8Array(2000)], 'a.png', { type: 'image/png' }))

    const first = await app.handle(new Request(`${ORIGIN}/`))
    const html = await first.text()

    page = shape(first)['content-security-policy']!

    asset = (/\/_kay\/entry-[^"]+\.js/).exec(html)![0]
    action = (/<form[^>]*action="([^"]+)"/).exec(html)![1]!.replaceAll('&amp;', '&')
  })

  const get = async (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) => app.handle(new Request(`${ORIGIN}${path}`, { headers, ...init }))

  // Every header of the answer but the policy, which must be the page's.
  async function expectAnswer(response: Response, status: number, expected: Record<string, string>) {
    const { 'content-security-policy': policy, ...seen } = shape(response)

    expect(response.status).toBe(status)
    expect(policy).toBe(page)
    expect(seen).toEqual({ ...SECURITY, ...expected })
  }

  it('a page carries the security headers, its request id and its caching', async () => {
    const response = await get('/')

    expect(page).toContain('default-src \'self\'')
    await expectAnswer(response, 200, { 'cache-control': 'private, no-cache', 'content-type': 'text/html; charset=utf-8', 'vary': 'cookie, Save-Data, accept-encoding' })
    await expectAnswer(await get('/', { 'accept-encoding': 'br' }), 200, { 'cache-control': 'private, no-cache', 'content-encoding': 'br', 'content-type': 'text/html; charset=utf-8', 'vary': 'cookie, Save-Data, accept-encoding' })
    await expectAnswer(await get('/nothing'), 404, {})
  })

  it('a HEAD answer carries the same', async () => {
    const response = await get('/', {}, { method: 'HEAD' })
    const { 'content-length': length, 'content-security-policy': policy, ...seen } = shape(response)

    expect(Number(length)).toBeGreaterThan(0)
    expect(policy).toBe(page)
    expect(seen).toEqual({ ...SECURITY, 'cache-control': 'private, no-cache', 'content-type': 'text/html; charset=utf-8', 'vary': 'cookie, Save-Data' })
  })

  it('an API route carries them beside its own headers, whether it answers a value or a Response', async () => {
    await expectAnswer(await get('/api/items'), 200, { 'content-type': JSON_TYPE })
    await expectAnswer(await get('/api/items/headed'), 200, { 'cache-control': 'no-store', 'content-type': JSON_TYPE, 'x-custom': 'yes' })
    await expectAnswer(await get('/api/items/response'), 200, { 'content-type': 'text/plain', 'vary': 'accept-encoding', 'x-own': 'mine' })
  })

  it('an API route answering a constant or a reused Response carries them, each answer with its own request id', async () => {
    const seen = new Set<string>()

    for (const path of ['/api/items/constant', '/api/items/reused', '/api/items/constant', '/api/items/reused']) {
      const response = await get(path)
      const id = response.headers.get('x-request-id')!

      // Compression varies a small body's answer only once the response has been through it, which is not what is under test.
      expect(Object.keys(shape(response)).filter(name => name !== 'vary')).toEqual(Object.keys({ ...SECURITY, 'content-security-policy': 0, 'content-type': 0 }).toSorted())
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })

  it('an API route answering a Response keeps its status, and the cookie it sets', async () => {
    await expectAnswer(await get('/api/items/created'), 201, { 'content-type': 'text/plain', 'vary': 'accept-encoding' })
    await expectAnswer(await get('/api/items/cookied'), 200, { 'content-type': 'text/plain', 'vary': 'accept-encoding', 'set-cookie': 'a=<value>; Path=<value>' })
  })

  it('a reused Response answered with a cookie or status never shows an earlier request\'s id', async () => {
    const ids = new Set<string>()

    for (const path of ['/api/items/reused', '/api/items/reused-cookied', '/api/items/reused-cookied']) {
      const response = await get(path)

      ids.add(response.headers.get('x-request-id')!)
    }

    expect(ids.size).toBe(3)
    expect((await get('/api/items/reused-cookied')).headers.getSetCookie()).toEqual(['b=2; Path=/'])
  })

  it('a build asset and a stored file carry them beside their caching', async () => {
    await expectAnswer(await get(asset), 200, { 'cache-control': IMMUTABLE, 'content-type': 'text/javascript;charset=utf-8', 'vary': 'accept-encoding' })
    await expectAnswer(await get(asset, { 'accept-encoding': 'br' }), 200, { 'cache-control': IMMUTABLE, 'content-encoding': 'br', 'content-type': 'text/javascript;charset=utf-8', 'vary': 'accept-encoding' })
    // However the name is spelled, the file is the build's, and no other.
    await expectAnswer(await get(asset.replace('entry', '%65ntry')), 200, { 'cache-control': IMMUTABLE, 'content-type': 'text/javascript;charset=utf-8', 'vary': 'accept-encoding' })
    await expectAnswer(await get(asset.replace('/entry', '/%2e%2e/entry'), { 'accept-encoding': 'br' }), 404, {})
    expect((await get('/_kay/..%2fpackage.json')).status).toBe(404)
    expect((await get('/_kay/%00')).status).toBe(404)
    await expectAnswer(await get(files.url(key)), 200, { 'accept-ranges': 'bytes', 'cache-control': IMMUTABLE, 'content-disposition': 'inline', 'content-type': 'image/png' })
  })

  it('a file route carries them on a range, a missing file, a bad link and a refused method', async () => {
    const ranged = await get(files.url(key), { range: 'bytes=0-9' })

    await expectAnswer(ranged, 206, { 'accept-ranges': 'bytes', 'cache-control': IMMUTABLE, 'content-disposition': 'inline', 'content-range': 'bytes 0-9/2000', 'content-type': 'image/png' })
    expect((await ranged.arrayBuffer()).byteLength).toBe(10)
    await expectAnswer(await get('/_kay/files/0123456789abcdef0123.png'), 404, { 'content-type': 'text/plain; charset=utf-8', 'vary': 'accept-encoding' })
    await expectAnswer(await get('/_kay/files/../x'), 404, {})
    await expectAnswer(await get('/_kay/files/private/0123456789abcdef0123.png?until=1&sig=x'), 403, { 'content-type': 'text/plain; charset=utf-8', 'vary': 'accept-encoding' })
    await expectAnswer(await get(files.url(key), {}, { method: 'POST' }), 404, {})
  })

  it('an action post carries them on its redirect, with its flash cookie, and on its refusal', async () => {
    const post = { method: 'POST', body: new URLSearchParams({ title: 'x' }) }

    await expectAnswer(await get(action, { origin: ORIGIN, referer: `${ORIGIN}/` }, post), 303, { 'location': `${ORIGIN}/`, 'set-cookie': 'kay_flash=<value>; Path=<value>; Max-Age=<value>; HttpOnly; SameSite=<value>' })
    await expectAnswer(await get(action, { origin: 'http://evil.test' }, post), 403, { 'content-type': 'text/plain; charset=utf-8', 'vary': 'accept-encoding' })
  })

  it('sends a post back to the page its form names, else its script\'s, else its referer, never to another site', async () => {
    const back = async (path: string, headers: Record<string, string>) => (await get(path, { origin: ORIGIN, ...headers }, { method: 'POST', body: new URLSearchParams({ title: 'x' }) })).headers.get('location')

    expect(await back(`${action}?kay_back=${encodeURIComponent('/named?a=1')}`, { 'x-kay-page': '/script', 'referer': `${ORIGIN}/ref` })).toBe(`${ORIGIN}/named?a=1`)
    expect(await back(action, { 'x-kay-page': '/script', 'referer': `${ORIGIN}/ref` })).toBe(`${ORIGIN}/script`)
    expect(await back(action, { referer: `${ORIGIN}/ref?b=2` })).toBe(`${ORIGIN}/ref?b=2`)
    expect(await back(`${action}?kay_back=${encodeURIComponent('https://evil.test/x')}`, { 'x-kay-page': 'https://evil.test/y', 'referer': `${ORIGIN}/ref` })).toBe(`${ORIGIN}/ref`)
    expect(await back(action, { 'x-kay-page': '//evil.test/y', 'referer': 'https://evil.test/z' })).toBe('/')
    expect(await back(action, { referer: '/relative' })).toBe('/')
  })

  it('hands Elysia the response the route made, with no copy of it', async () => {
    const dir = await fixtureCopy('answers')
    let made = Promise.withResolvers<unknown>()
    const inner = await pages({ routes: `${dir}/src/routes`, api: `${dir}/src/api`, prebuilt: false, log: false, compress: false, storage: memoryFiles() })
    const stored = await files.put(new File([new Uint8Array(2000)], 'b.png', { type: 'image/png' }))
    const outer = new Elysia().onAfterResponse({ as: 'global' }, ({ responseValue }) => {
      made.resolve(responseValue)
    }).use(inner)
    const sent = async (path: string, init?: RequestInit) => {
      made = Promise.withResolvers<unknown>()

      const response = await outer.handle(new Request(`${ORIGIN}${path}`, init))

      // After-response hooks run once the response is out.
      const answered = await made.promise

      return { response, same: response === answered }
    }

    expect((await sent('/')).same).toBe(true)
    expect((await sent('/api/items')).same).toBe(true)
    expect((await sent('/api/items/headed')).same).toBe(true)
    expect((await sent('/api/items/response')).same).toBe(true)
    expect((await sent('/api/items/reused')).same).toBe(true)
    expect((await sent(asset)).same).toBe(true)
    expect((await sent(files.url(stored))).same).toBe(true)

    const own = (/<form[^>]*action="([^"]+)"/).exec(await (await sent('/')).response.text())![1]!.replaceAll('&amp;', '&')
    const posted = await sent(own, { method: 'POST', body: new URLSearchParams({ title: 'x' }), headers: { origin: ORIGIN, referer: `${ORIGIN}/` } })

    expect(posted.response.status).toBe(303)
    expect(posted.same).toBe(true)
  })

  it('keeps them on a file route whose store throws', async () => {
    const store = memoryFiles()
    const broken = await pages({ routes: `${await fixtureCopy('answers')}/src/routes`, prebuilt: false, log: false, storage: { ...store, read: async () => {
      throw new Error('store down')
    } } })
    const response = await broken.handle(new Request(`${ORIGIN}/_kay/files/0123456789abcdef0123.png`))

    expect(response.status).toBe(500)
    expect(response.headers.get('content-security-policy')).toBe(page)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID)
  })
})

describe('HSTS on every kind of answer of an https site', () => {
  it('reaches the pages, build assets, stored files, their errors and the API', async () => {
    const dir = await fixtureCopy('answers')
    const app = await pages({ routes: `${dir}/src/routes`, api: `${dir}/src/api`, prebuilt: false, log: false, site: 'https://shop.example', dev: false, storage: memoryFiles() })
    const key = await files.put(new File([new Uint8Array(2000)], 'a.png', { type: 'image/png' }))
    const html = await (await app.handle(new Request(`${ORIGIN}/`))).text()
    const asset = (/\/_kay\/entry-[^"]+\.js/).exec(html)![0]
    const hsts = async (path: string, init: RequestInit = {}) => (await app.handle(new Request(`${ORIGIN}${path}`, init))).headers.get('strict-transport-security')

    for (const path of ['/', asset, files.url(key), '/_kay/missing.js', '/no-such-page'])
      expect(await hsts(path)).toBe('max-age=31536000')

    expect(await hsts(files.url(key), { headers: { range: 'bytes=0-9' } })).toBe('max-age=31536000')
    expect(await hsts('/', { method: 'HEAD' })).toBe('max-age=31536000')
  })
})

describe('the asset route\'s cache of build files', () => {
  const serve = async (dev: boolean) => {
    const dir = resolve(await scratchDir('asset-names-'))
    const app = new Elysia()

    await Bun.write(join(dir, 'plain.js'), 'plain')
    await Bun.write(join(dir, 'a b.js'), 'spaced')
    await Bun.write(join(dir, 'dir name', 'é.js'), 'nested')
    await serveBuildFiles(app, { dir } as ClientBuild, { dev, security: undefined })

    return { dir, get: async (path: string) => app.handle(new Request(`${ORIGIN}/_kay${path}`)) }
  }

  // A file taken off the disk after its first answer is still answered only when its spelling was kept, which tells what the route cached.
  async function cached(dev: boolean, first: string, second: string, gone: string) {
    const { dir, get } = await serve(dev)

    try {
      expect((await get(first)).status).toBe(200)
      await rm(join(dir, gone))

      return (await get(second)).status
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('serves a source map in development only', async () => {
    for (const dev of [true, false]) {
      const { dir, get } = await serve(dev)

      try {
        await Bun.write(join(dir, 'chunk.js.map'), '{"version":3,"sources":[],"mappings":""}')
        expect((await get('/chunk.js.map')).status).toBe(dev ? 200 : 404)
        expect((await get('/plain.js')).status).toBe(200)
      }
      finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })

  it('keeps a file whose name needs encoding under the spelling the build lists', async () => {
    expect(await cached(false, '/a%20b.js', '/a%20b.js', 'a b.js')).toBe(200)
    expect(await cached(false, '/dir%20name/%C3%A9.js', '/dir%20name/%C3%A9.js', 'dir name/é.js')).toBe(200)
    expect(await cached(false, '/plain.js', '/plain.js', 'plain.js')).toBe(200)
  })

  it('keeps no other spelling of it, so requests cannot grow the map', async () => {
    expect(await cached(false, '/a%20b.js', '/a%20b%2ejs', 'a b.js')).toBe(404)
    expect(await cached(false, '/a%20b%2ejs', '/a%20b%2ejs', 'a b.js')).toBe(404)
    expect(await cached(false, '/a%20b.js', '/a%2520b.js', 'a b.js')).toBe(404)
    expect(await cached(false, '/plain.js', '/%70lain.js', 'plain.js')).toBe(404)
    expect(await cached(false, '/dir%20name/%C3%A9.js', '/dir%20name/%c3%a9.js', 'dir name/é.js')).toBe(404)
    expect(await cached(false, '/plain.js', '/plain.js/', 'plain.js')).toBe(404)
    expect(await cached(false, '/dir%20name%2f%C3%A9.js', '/dir%20name%2f%C3%A9.js', 'dir name/é.js')).toBe(404)
  })

  it('keeps nothing in development', async () => {
    expect(await cached(true, '/a%20b.js', '/a%20b.js', 'a b.js')).toBe(404)
    expect(await cached(true, '/plain.js', '/plain.js', 'plain.js')).toBe(404)
  })

  it('answers a spelling of the file in the same way, and refuses a name outside the build or an unsafe one', async () => {
    const { dir, get } = await serve(false)

    try {
      for (const spelled of ['/a%20b.js', '/a%20b%2ejs', '/%61%20b.js'])
        expect(await (await get(spelled)).text()).toBe('spaced')

      for (const hostile of ['/..%2fpackage.json', '/%2e%2e%2fplain.js', '/dir%20name/..%2f..%2fplain.js', '/a%20b.js%00', '/%00', '/a%2520b.js', '/dir%20name', '/missing%20name.js'])
        expect((await get(hostile)).status).toBe(404)

      // A refused name is not kept either.
      await rm(join(dir, 'plain.js'))
      expect((await get('/plain.js')).status).toBe(404)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
