import { afterAll, afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { definePlugin } from '../src/plugins/index'
import { isInside } from '../src/plugins/public'
import { action, createRateLimitStore, escJson, readStringFields, safeEqual } from '../src/server/public'
import { testApp } from '../src/test/index'

function post(body: BodyInit, contentType?: string): Request {
  return new Request('http://app.test/x', { method: 'POST', body, headers: contentType === undefined ? {} : { 'content-type': contentType } })
}

describe('isInside: the one path confinement check (#3672)', () => {
  test('a child and a grandchild are inside, the folder itself only with orSame', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b/c/d.md')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(false)
    expect(isInside('/a/b', '/a/b', { orSame: true })).toBe(true)
  })

  test('a name starting with two dots is inside', () => {
    expect(isInside('/a/b', '/a/b/..x')).toBe(true)
    expect(isInside('/a/b', '/a/b/..x/y', { orSame: true })).toBe(true)
  })

  test('the parent, a sibling, a sibling sharing the prefix and another root are outside', () => {
    expect(isInside('/a/b', '/a')).toBe(false)
    expect(isInside('/a/b', '/a', { orSame: true })).toBe(false)
    expect(isInside('/a/b', '/a/x')).toBe(false)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a/b/../c')).toBe(false)
    expect(isInside('/a/b', '/z/b/c')).toBe(false)
  })

  test('a trailing slash on either side changes nothing', () => {
    expect(isInside('/a/b/', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b/', { orSame: true })).toBe(true)
    expect(isInside('/a/b/', '/a/b')).toBe(false)
  })
})

describe('readStringFields: a request body as string fields (#3672)', () => {
  test('reads an urlencoded body, the last of a repeated name winning', async () => {
    expect({ ...await readStringFields(post('email=a%40b.c&tag=x&tag=y', 'application/x-www-form-urlencoded')) }).toEqual({ email: 'a@b.c', tag: 'y' })
  })

  test('reads a multipart body and drops its file entries', async () => {
    const form = new FormData()
    form.set('name', 'Ada')
    form.set('avatar', new File(['png'], 'a.png'))
    expect({ ...await readStringFields(new Request('http://app.test/x', { method: 'POST', body: form })) }).toEqual({ name: 'Ada' })
  })

  test('reads a JSON object and drops what is not a string', async () => {
    const fields = await readStringFields(post('{"email":"a@b.c","age":3,"roles":["admin"],"next":null}', 'application/json'))
    expect({ ...fields }).toEqual({ email: 'a@b.c' })
  })

  test('a JSON null, array or number, and an unknown content type give no field', async () => {
    expect({ ...await readStringFields(post('null', 'application/json')) }).toEqual({})
    expect({ ...await readStringFields(post('["a","b"]', 'application/json')) }).toEqual({})
    expect({ ...await readStringFields(post('5', 'application/json')) }).toEqual({})
    expect({ ...await readStringFields(post('email=a', 'text/plain')) }).toEqual({})
  })

  test('__proto__ and constructor are kept as plain fields, on a record with no prototype', async () => {
    const form = await readStringFields(post('__proto__=p&constructor=c', 'application/x-www-form-urlencoded'))
    expect(Object.getPrototypeOf(form)).toBe(null)
    expect(Object.entries(form)).toEqual([['__proto__', 'p'], ['constructor', 'c']])
    const json = await readStringFields(post('{"__proto__":"p","constructor":"c"}', 'application/json'))
    expect(Object.entries(json)).toEqual([['__proto__', 'p'], ['constructor', 'c']])
  })

  test('a malformed JSON body throws, for the caller to answer 400', async () => {
    expect(readStringFields(post('{', 'application/json'))).rejects.toThrow()
  })
})

describe('safeEqual: a constant-time compare of two secrets (#3672)', () => {
  test('equal strings match, the empty ones and non-ASCII ones included', () => {
    expect(safeEqual('s3cret-token', 's3cret-token')).toBe(true)
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('clé-été', 'clé-été')).toBe(true)
  })

  test('strings differing by a character, by length or by accent do not match', () => {
    expect(safeEqual('s3cret-token', 's3cret-tokem')).toBe(false)
    expect(safeEqual('s3cret-token', 's3cret-token2')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
    expect(safeEqual('clé', 'cle')).toBe(false)
  })

  test('every byte of the two digests counts', () => {
    // Their SHA-256 digests share the first byte with that of 's3cret-token', then the last one.
    expect(safeEqual('s3cret-token', 's3cret-token-618')).toBe(false)
    expect(safeEqual('s3cret-token', 's3cret-token-16')).toBe(false)
  })
})

describe('escJson: JSON text made safe inside a <script> element (#3672)', () => {
  test('a closing tag, a comment opener and the two line separators are escaped', () => {
    const json = JSON.stringify({ a: '</script><script>x()</script>', b: '<!--', c: 'l\u2028m\u2029n' })
    expect(escJson(json)).toBe('{"a":"\\u003c/script>\\u003cscript>x()\\u003c/script>","b":"\\u003c!--","c":"l\\u2028m\\u2029n"}')
  })

  test('the escaped text parses back to the same value, an already-escaped string unchanged', () => {
    const value = { a: '</script>', b: 'l\u2028m\u2029n', c: '\\u003c stays', d: 3 }
    expect(JSON.parse(escJson(JSON.stringify(value)))).toEqual(value)
  })
})

const T0 = Date.UTC(2026, 10, 27, 12)

describe('createRateLimitStore: a sliding window per key, bounded (#3673)', () => {
  afterEach(() => setSystemTime())

  test('the request at the limit passes, the next waits for the oldest hit to leave the window, then passes', () => {
    const store = createRateLimitStore()
    const limiter = store.limiter({ max: 2, windowMs: 10_000 })
    setSystemTime(T0)
    expect(limiter.hit('a')).toBe(0)
    setSystemTime(T0 + 1000)
    expect(limiter.hit('a')).toBe(0)
    setSystemTime(T0 + 2500)
    expect(limiter.hit('a')).toBe(8)
    setSystemTime(T0 + 9999)
    expect(limiter.hit('a')).toBe(1)
    setSystemTime(T0 + 10_000)
    expect(limiter.hit('a')).toBe(0)
    expect(limiter.hit('a')).toBe(1)
    store.close()
  })

  test('keys and limiters are counted apart', () => {
    setSystemTime(T0)
    const store = createRateLimitStore()
    const first = store.limiter({ max: 1, windowMs: 60_000 })
    const second = store.limiter({ max: 1, windowMs: 60_000 })
    expect(first.hit('a')).toBe(0)
    expect(first.hit('b')).toBe(0)
    expect(second.hit('a')).toBe(0)
    expect(first.hit('a')).toBe(60)
    store.close()
  })

  test('past maxKeys the least recently used key goes, and its client starts afresh', () => {
    setSystemTime(T0)
    const store = createRateLimitStore({ maxKeys: 3 })
    const limiter = store.limiter({ max: 1, windowMs: 60_000 })
    for (const key of ['a', 'b', 'c'])
      limiter.hit(key)
    expect(limiter.hit('a')).toBe(60)
    limiter.hit('d')
    expect(store.size).toBe(3)
    expect(limiter.hit('a')).toBe(60)
    expect(limiter.hit('b')).toBe(0)
    store.close()
  })

  test('past maxHits across keys the least recently used keys go', () => {
    setSystemTime(T0)
    const store = createRateLimitStore({ maxHits: 3 })
    const limiter = store.limiter({ max: 5, windowMs: 60_000 })
    limiter.hit('a')
    limiter.hit('a')
    limiter.hit('b')
    expect(store.size).toBe(2)
    limiter.hit('b')
    expect(store.size).toBe(1)
    store.close()
  })

  test('a sweep drops the keys with no hit left in their window', () => {
    setSystemTime(T0)
    const store = createRateLimitStore()
    store.limiter({ max: 5, windowMs: 1000 }).hit('short')
    store.limiter({ max: 5, windowMs: 60_000 }).hit('long')
    expect(store.sweep(T0 + 999)).toBe(0)
    expect(store.sweep(T0 + 1000)).toBe(1)
    expect(store.size).toBe(1)
    store.close()
  })
})

describe('rateLimit on plugin routes and actions (#3673)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kay-rate-limit-'))
  let calls = 0
  const limited = definePlugin({
    name: 'limited',
    server(api) {
      api.route('GET', '/limited', () => {
        calls++
        return new Response('ok')
      }, { rateLimit: { max: 2, windowMs: 60_000 } })
      api.route('GET', '/by-account', () => new Response('ok'), { rateLimit: { max: 1, windowMs: 60_000, key: ctx => ctx.request.headers.get('x-account') ?? undefined } })
    },
  })
  mkdirSync(join(dir, 'src/routes'), { recursive: true })
  mkdirSync(join(dir, 'src/actions'), { recursive: true })
  writeFileSync(join(dir, 'src/actions/contact.ts'), `
    import { action } from '@kayjs/kay/server'
    const passAll = { '~standard': { version: 1 as const, vendor: 'test', validate: (v: unknown) => ({ value: v as Record<string, string> }) } }
    export const contact = action(passAll, input => ({ sent: input.message }), { rateLimit: { max: 1, windowMs: 30_000 } })
  `)
  writeFileSync(join(dir, 'src/routes/index.tsx'), `
    import { getActionError } from '@kayjs/kay/server'
    import type { PageProps } from '@kayjs/kay/server'
    import { contact } from '../actions/contact'
    export default function Contact({ locals }: PageProps) {
      const err = getActionError(locals)
      return (
        <main>
          {err && <p class="flash">{err.error}|{err.values?.message ?? ''}</p>}
          <form action={contact} method="post"><label>Message <input name="message" /></label><button>Send</button></form>
        </main>
      )
    }
  `)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const from = (ip: string) => ({ 'x-forwarded-for': ip })

  test('a route answers 429 with Retry-After past the limit, without running its handler', async () => {
    const app = await testApp({ root: dir, plugins: [limited], trustProxy: true })
    try {
      calls = 0
      expect((await app.get('/limited', from('1.1.1.1'))).status).toBe(200)
      expect((await app.get('/limited', from('1.1.1.1'))).status).toBe(200)
      const refused = await app.get('/limited', from('1.1.1.1'))
      expect(refused.status).toBe(429)
      expect(refused.headers.get('retry-after')).toBe('60')
      expect(await refused.json()).toEqual({ ok: false, status: 429, error: 'Too many requests' })
      expect(calls).toBe(2)
    }
    finally {
      await app.app.dispose?.()
    }
  })

  test('behind a trusted proxy two clients are told apart by X-Forwarded-For; with none they share a key', async () => {
    const proxied = await testApp({ root: dir, prebuilt: true, plugins: [limited], trustProxy: true })
    const direct = await testApp({ root: dir, prebuilt: true, plugins: [limited] })
    try {
      for (const app of [proxied, direct]) {
        await app.get('/limited', from('1.1.1.1'))
        await app.get('/limited', from('1.1.1.1'))
      }
      expect((await proxied.get('/limited', from('2.2.2.2'))).status).toBe(200)
      expect((await direct.get('/limited', from('2.2.2.2'))).status).toBe(429)
    }
    finally {
      await proxied.app.dispose?.()
      await direct.app.dispose?.()
    }
  })

  test('a key(ctx) counts by what it returns, and by the address when it returns nothing', async () => {
    const app = await testApp({ root: dir, prebuilt: true, plugins: [limited], trustProxy: true })
    try {
      expect((await app.get('/by-account', { ...from('1.1.1.1'), 'x-account': 'ann' })).status).toBe(200)
      expect((await app.get('/by-account', { ...from('1.1.1.1'), 'x-account': 'bob' })).status).toBe(200)
      expect((await app.get('/by-account', { ...from('2.2.2.2'), 'x-account': 'ann' })).status).toBe(429)
      expect((await app.get('/by-account', from('3.3.3.3'))).status).toBe(200)
      expect((await app.get('/by-account', from('3.3.3.3'))).status).toBe(429)
    }
    finally {
      await app.app.dispose?.()
    }
  })

  test('an action called from script gets a 429 ActionResult; a form comes back to its page with the error and what was typed', async () => {
    const app = await testApp({ root: dir, plugins: [limited], trustProxy: true })
    try {
      const url = app.manifest!.actions.find(a => a.exportName === 'contact')!.url
      const submit = (headers: Record<string, string>) => {
        const body = new FormData()
        body.set('message', 'hello')
        return app.fetch(new Request(`http://localhost${url}`, { method: 'POST', body, headers: { origin: 'http://localhost', ...from('1.1.1.1'), ...headers } }))
      }
      expect((await submit({ accept: 'application/json' })).status).toBe(200)
      const json = await submit({ accept: 'application/json' })
      expect(json.status).toBe(429)
      expect(json.headers.get('retry-after')).toBe('30')
      expect(await json.json()).toEqual({ ok: false, status: 429, error: 'Too many requests' })

      const form = await submit({ accept: 'text/html', referer: 'http://localhost/' })
      expect(form.status).toBe(303)
      expect(form.headers.get('location')).toBe('http://localhost/')
      expect(form.headers.get('retry-after')).toBe('30')
      const cookie = form.headers.get('set-cookie')!.split(';')[0]!
      expect(await (await app.get('/', { cookie })).text()).toContain('<p class="flash">Too many requests|hello</p>')
    }
    finally {
      await app.app.dispose?.()
    }
  })

  test('disposing the server stops its sweep timer', async () => {
    const intervals = spyOn(globalThis, 'setInterval')
    const cleared = spyOn(globalThis, 'clearInterval')
    try {
      const app = await testApp({ root: dir, prebuilt: true, plugins: [limited] })
      const sweepTimers = intervals.mock.results.filter((_, i) => intervals.mock.calls[i]![1] === 60_000).map(r => r.value as unknown)
      expect(sweepTimers).toHaveLength(1)
      await app.app.dispose?.()
      expect(cleared.mock.calls.map(c => c[0] as unknown)).toContain(sweepTimers[0])
    }
    finally {
      intervals.mockRestore()
      cleared.mockRestore()
    }
  })

  test('a limit that cannot count anything throws where it is set', () => {
    expect(() => action(() => 1, { rateLimit: { max: 0, windowMs: 1000 } })).toThrow('kay: rateLimit.max of an action is 0; give a whole number of requests, 1 or more.')
    expect(() => action(() => 1, { rateLimit: { max: 1.5, windowMs: 1000 } })).toThrow('rateLimit.max of an action is 1.5')
    expect(() => action(() => 1, { rateLimit: { max: 1, windowMs: 0 } })).toThrow('kay: rateLimit.windowMs of an action is 0; give the window in milliseconds, above 0.')
  })

  test('a route limit that cannot count anything stops the server from starting, naming the route', async () => {
    const broken = definePlugin({
      name: 'broken',
      server(api) {
        api.route('POST', '/hook/', () => new Response('ok'), { rateLimit: { max: 10, windowMs: Number.NaN } })
      },
    })
    await expect(testApp({ root: dir, prebuilt: true, plugins: [broken] })).rejects.toThrow('kay: rateLimit.windowMs of POST /hook from "broken" is NaN')
  })
})
