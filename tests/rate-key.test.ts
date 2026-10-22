import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { protectionRefusal } from '../src/server/protection'
import { testSite } from '../src/test'
import { parsingRoutes } from './elysia'
import { pages } from './shared-pages'

const root = 'tests/fixtures/rate-keys'
const locals = (request: Request) => ({ user: request.headers.get('x-user') ?? undefined })
const sites = await Promise.all(Array.from({ length: 4 }, async () => testSite({ root, islands: false, locals })))
const [first, second, third, fourth] = sites as [typeof sites[0], typeof sites[0], typeof sites[0], typeof sites[0]]
const mounted = await testSite({ root, islands: false, base: '/blog', trailingSlash: 'always', locals })
const actions = await import(join(import.meta.dir, 'fixtures/rate-keys/src/routes/index.kay')) as Record<'perUser' | 'empty' | 'throws' | 'rejects' | 'notText' | 'long' | 'counted' | 'inLocale', Action<Record<never, never>, string>>

afterAll(async () => {
  await Promise.all([...sites, mounted].map(async site => site.close()))
})

const as = (user: string) => ({ headers: { 'x-user': user } })

describe('a rate limit with a key', () => {
  it('counts each key apart whatever the client address', async () => {
    expect(await first.call(actions.perUser, {}, as('ada'))).toBe('ok')
    expect(await first.call(actions.perUser, {}, as('grace'))).toBe('ok')
    expect((await first.refusal(actions.perUser, {}, as('ada'))).status).toBe(429)
    // The same person from another address is the same key.
    expect((await second.refusal(actions.perUser, {}, as('ada'))).status).toBe(429)
  })

  it('counts a key under the same limits behind a base and a trailing slash', async () => {
    expect(await mounted.call(actions.perUser, {}, as('ada-mounted'))).toBe('ok')
    expect((await mounted.refusal(actions.perUser, {}, as('ada-mounted'))).status).toBe(429)
    expect(await mounted.call(actions.perUser, {}, as('grace-mounted'))).toBe('ok')
  })

  it('falls back to the client address when the key gives none', async () => {
    // No user header: `undefined`, so the visitor counts as their address.
    expect(await third.call(actions.perUser)).toBe('ok')
    expect((await third.refusal(actions.perUser, {})).status).toBe(429)
    expect(await fourth.call(actions.perUser)).toBe('ok')
  })

  it('never lifts the limit for a key that is empty, not a text, or throws', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      for (const limited of [actions.empty, actions.throws, actions.rejects, actions.notText]) {
        expect(await first.call(limited)).toBe('ok')
        expect((await first.refusal(limited, {})).status).toBe(429)
        // Another address is another client, so the fallback is the address and not one bucket for everyone.
        expect(await second.call(limited)).toBe('ok')
      }
    }
    finally {
      warn.mockRestore()
    }
  })

  it('keeps a very long key within bounds and tells two long keys apart', async () => {
    const same = 'x'.repeat(5000)

    expect(await third.call(actions.long, {}, { headers: { 'x-key': `${same}a` } })).toBe('ok')
    expect(await third.call(actions.long, {}, { headers: { 'x-key': `${same}b` } })).toBe('ok')
    expect((await third.refusal(actions.long, {}, { headers: { 'x-key': `${same}a` } })).status).toBe(429)
  })

  it('counts the posts that went through under the key they were let in by', async () => {
    expect(await fourth.call(actions.counted, {}, as('ada-counted'))).toBe('ok')
    // The handler changed the locals, which the count does not follow.
    expect((await fourth.refusal(actions.counted, {}, as('ada-counted'))).status).toBe(429)
  })

  it('leaves Elysia parsing no cookie, query or header on a route whose action has a key', async () => {
    expect(parsingRoutes(await pages({ root, prebuilt: false, security: false }))).toEqual([])
  })

  it('reads the request locale', async () => {
    expect(await first.call(actions.inLocale)).toBe('ok')
    expect((await first.refusal(actions.inLocale, {})).status).toBe(429)
  })

  it('is read by the protection a test drives directly, with the context it is given', async () => {
    const seen: string[] = []
    const limited = { url: '/_kay/action/direct', protection: { rateLimit: { max: 1, window: '1m', key: (ctx: { client: string }) => {
      seen.push(ctx.client)

      return 'one'
    } } } } as never
    const context = () => ({ request: new Request('http://localhost/'), locale: 'en', cookies: new Bun.CookieMap(''), locals: {} }) as never

    expect(await protectionRefusal(limited, new Request('http://localhost/'), { body: {}, form: false, server: null, plain: false, keyContext: context })).toBeUndefined()
    expect(await protectionRefusal(limited, new Request('http://localhost/'), { body: {}, form: false, server: null, plain: false, keyContext: context })).toMatchObject({ status: 429 })
    expect(seen.length).toBe(2)
  })
})
