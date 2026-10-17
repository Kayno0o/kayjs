import type { Duration } from 'kay'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { memoryStore } from '../src/memoryStore'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const DAY_MS = 24 * 60 * 60 * 1000

afterEach(() => {
  setSystemTime()
})

describe('time options take a Duration', () => {
  test('rememberMaxAge takes a string or seconds and a bad one fails at boot naming it', async () => {
    for (const rememberMaxAge of ['45d', 45 * 24 * 60 * 60] as const) {
      const { browser, store } = testApp({ rememberMaxAge })
      const ada = browser()

      await ada.call('register', { email: 'ada@example.com', password: PASSWORD, remember: true })
      expect((await store.sessions.listByUser((await ada.json('/me') as { id: string }).id))[0]!.maxAge).toBe(45 * 24 * 60 * 60)
    }

    expect(() => testApp({ rememberMaxAge: '3 weeks' as Duration })).toThrow('kayjs-auth: rememberMaxAge is \'3 weeks\'')
    expect(() => testApp({ rememberMaxAge: 0 })).toThrow('kayjs-auth: rememberMaxAge is 0')
  })

  test('a sub-second rememberMaxAge is stored as whole seconds, rounded up', async () => {
    const { browser, store } = testApp({ rememberMaxAge: 0.4 })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD }, { remember: true })
    expect((await store.sessions.listByUser((await store.users.findByEmail('ada@example.com'))!.id))[0]!.maxAge).toBe(1)
  })

  test('audit.maxAge takes a string, and a bad one fails at boot naming it', async () => {
    const { browser, store } = testApp({ audit: { maxAge: '1m' } })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000))
    await ada.fetch('/sign-out', { method: 'POST' })

    expect((await store.audit!.list({ limit: 10 })).map(entry => entry.event)).toEqual(['signed-out'])
    expect(() => testApp({ audit: { maxAge: 'a year' as Duration } })).toThrow('kayjs-auth: audit.maxAge is \'a year\'')
  })

  test('a limit window takes a string, handed to the store in seconds, and a bad one names its limit', async () => {
    const windows: number[] = []
    const base = memoryStore()
    const store = { ...base, attempts: { ...base.attempts, hit: async (key: string, window: number) => {
      windows.push(window)

      return base.attempts.hit(key, window)
    } } }
    const { browser } = testApp({ store, limits: { register: { max: 1, window: '2h' } } })

    await browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    expect(windows).toContain(2 * 60 * 60)
    expect(() => testApp({ limits: { signIn: { max: 1, window: '-5m' } } })).toThrow('kayjs-auth: limits.signIn.window is \'-5m\'')
  })

  test('a token\'s expiresIn takes a string, and a bad one answers expiry', async () => {
    const { browser, store } = testApp({ scopes: ['posts:read'] })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    const minted = await ada.callOk('createToken', { password: PASSWORD }, 'Phone', { expiresIn: '30d' })
    const [stored] = await store.bearerTokens.listByUser((await ada.json('/me') as { id: string }).id)

    expect(minted.id).toBe(stored!.id)
    expect(stored!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(30 * DAY_MS - 60_000)
    expect(await ada.call('createToken', { password: PASSWORD }, 'Tablet', { expiresIn: 'forever' as Duration })).toEqual({ ok: false, error: 'expiry' })
    expect(await ada.call('createToken', { password: PASSWORD }, 'Tablet', { expiresIn: 3600 })).toMatchObject({ ok: true })
  })
})
