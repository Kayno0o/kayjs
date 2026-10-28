import type { Duration } from 'kay'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { memoryAuthStore } from '../src/memoryStore'
import { testApp } from './helpers/app'
import { untilHolds } from './helpers/until'

const PASSWORD = 'correct horse battery'
const DAY_MS = 24 * 60 * 60 * 1000

afterEach(() => {
  setSystemTime()
})

describe('time options take a Duration', () => {
  test('remember.maxAge takes a string, and a bad one fails at boot naming it', async () => {
    for (const maxAge of ['45d' as const]) {
      const { browser, store } = testApp({ remember: { maxAge } })
      const ada = browser()

      await ada.call('password.register', { email: 'ada@example.com', password: PASSWORD }, { remember: true })
      expect((await store.sessions.listByUser((await ada.json('/me') as { id: string }).id))[0]!.maxAge).toBe(45 * 24 * 60 * 60)
    }

    expect(() => testApp({ remember: { maxAge: '3 weeks' as Duration } })).toThrow('kay: remember.maxAge is \'3 weeks\'')
    expect(() => testApp({ remember: { maxAge: '0s' } })).toThrow('kay: remember.maxAge is \'0s\'')
  })

  test('a sub-second remember.maxAge is stored as whole seconds, rounded up', async () => {
    const { browser, store } = testApp({ remember: { maxAge: '0.4s' } })
    const ada = browser()

    await ada.call('password.register', { email: 'ada@example.com', password: PASSWORD }, { remember: true })
    expect((await store.sessions.listByUser((await store.users.findByEmail('ada@example.com'))!.id))[0]!.maxAge).toBe(1)
  })

  test('a sub-second guests.maxAge is read as whole seconds, rounded up', async () => {
    const cutoffs: Date[] = []
    const base = memoryAuthStore()
    const store = { ...base, users: { ...base.users, staleGuests: async (createdBefore: Date, limit: number) => {
      cutoffs.push(createdBefore)

      return base.users.staleGuests!(createdBefore, limit)
    } } }
    const { browser, pruned } = testApp({ store, guests: { maxAge: '0.4s' } })
    const now = Date.now()

    setSystemTime(now)
    await browser().json('/me')
    await pruned()

    expect(cutoffs.map(cutoff => now - cutoff.getTime())).toEqual([1000])
  })

  test('a sub-second audit.maxAge is read as whole seconds, rounded up', async () => {
    const cutoffs: Date[] = []
    const base = memoryAuthStore()
    const store = { ...base, audit: { ...base.audit!, prune: async (before: Date) => {
      cutoffs.push(before)
      await base.audit!.prune(before)
    } } }
    const { browser } = testApp({ store, audit: { maxAge: '0.4s' } })
    const now = Date.now()

    setSystemTime(now)
    await browser().call('password.register', { email: 'ada@example.com', password: PASSWORD })
    await untilHolds(() => cutoffs.length > 0)

    expect(cutoffs.length).toBeGreaterThan(0)
    expect(cutoffs.map(cutoff => now - cutoff.getTime())).toEqual(cutoffs.map(() => 1000))
  })

  test('audit.maxAge takes a string, and a bad one fails at boot naming it', async () => {
    const { browser, store } = testApp({ audit: { maxAge: '1m' } })
    const ada = browser()

    await ada.call('password.register', { email: 'ada@example.com', password: PASSWORD })
    setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000))
    await ada.fetch('/sign-out', { method: 'POST' })

    expect((await store.audit!.list({ limit: 10 })).map(entry => entry.event)).toEqual(['signed-out'])
    expect(() => testApp({ audit: { maxAge: 'a year' as Duration } })).toThrow('kay: audit.maxAge is \'a year\'')
  })

  test('a limit window takes a string, handed to the store as written, and a bad one names its limit', async () => {
    const windows: Duration[] = []
    const base = memoryAuthStore()
    const store = { ...base, rates: { ...base.rates!, hit: async (key: string, window: Duration) => {
      windows.push(window)

      return base.rates!.hit(key, window)
    } } }
    const { browser } = testApp({ store, rateLimit: { register: { max: 1, window: '2h' } } })

    await browser().call('password.register', { email: 'ada@example.com', password: PASSWORD })
    expect(windows).toContain('2h')
    expect(() => testApp({ rateLimit: { signIn: { max: 1, window: '-5m' } } })).toThrow('rateLimit.signIn.window is \'-5m\'')
  })

  test('rateLimit windows reach the store as written', async () => {
    const windows: Duration[] = []
    const base = memoryAuthStore()
    const store = { ...base, rates: { ...base.rates!, hit: async (key: string, window: Duration) => {
      windows.push(window)

      return base.rates!.hit(key, window)
    } } }
    const { browser } = testApp({ store, rateLimit: { register: { max: 1, window: '3h' }, signIn: { max: 1, window: '1h' } } })

    await browser().call('password.register', { email: 'ada@example.com', password: PASSWORD })
    expect(windows).toContain('3h')
    expect(windows).not.toContain('2h')
    expect(() => testApp({ rateLimit: { signIn: { max: 1, window: '-5m' } } })).toThrow('kay: rateLimit.signIn.window is \'-5m\'')
  })

  test('a token\'s maxAge takes a string, and a bad one answers expiry', async () => {
    const { browser, store } = testApp({ scopes: ['posts:read'] })
    const ada = browser()

    await ada.call('password.register', { email: 'ada@example.com', password: PASSWORD })

    const minted = await ada.callOk('tokens.create', { password: PASSWORD }, 'Phone', { maxAge: '30d' })
    const [stored] = await store.bearerTokens.listByUser((await ada.json('/me') as { id: string }).id)

    expect(minted.id).toBe(stored!.id)
    expect(stored!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(30 * DAY_MS - 60_000)
    expect(await ada.call('tokens.create', { password: PASSWORD }, 'Tablet', { maxAge: 'forever' as Duration })).toEqual({ ok: false, error: 'expiry' })
    expect(await ada.call('tokens.create', { password: PASSWORD }, 'Tablet', { maxAge: '3600s' })).toMatchObject({ ok: true })
  })
})
