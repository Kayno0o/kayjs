import type { AuthStore } from '../src/store'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { memoryRates } from 'kay/server'
import { setupStore } from '../../../src/server/app-store'
import { TimeoutError } from '../../../src/server/pg-poll'
import { DEFAULT_LIMITS, memoryAuthStore } from '../src'
import { log } from '../src/log'
import { memoryAuthRates } from '../src/rates'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery staple'
const WRONG = 'wrong password!'

// A store keeping no counts of its own, as one an app writes over its tables.
function withoutRates(): AuthStore {
  return { ...memoryAuthStore(), rates: undefined }
}

async function signIn(browser: ReturnType<typeof testApp>['browser'], password: string): Promise<unknown> {
  return browser().post('/password', { identifier: 'ada@example.com', password })
}

async function registered(store: AuthStore) {
  const app = testApp({ store, rateLimit: { signInAccount: { max: 2, window: '15m' } } })

  await app.browser().post('/register', { email: 'ada@example.com', password: PASSWORD })

  return app
}

afterEach(() => setupStore(undefined))

describe('where attempts are counted', () => {
  test('a store without rates counts in the app\'s store.rates, apart from kay\'s own keys, and a right password clears the count there', async () => {
    const shared = memoryRates()
    const hit = spyOn(shared, 'hit')

    setupStore({ rates: shared })

    const { browser } = await registered(withoutRates())

    await signIn(browser, WRONG)
    expect(await signIn(browser, PASSWORD)).toMatchObject({ ok: true })
    await signIn(browser, WRONG)
    await signIn(browser, WRONG)
    expect(await signIn(browser, PASSWORD)).toEqual({ ok: false, error: 'limited' })

    const keys = hit.mock.calls.map(call => call[0])

    expect(keys.some(key => key.startsWith('kayjs-auth\nsign-in-account:'))).toBe(true)
    expect(keys.filter(key => !key.startsWith('kayjs-auth\n'))).toEqual([])
  })

  test('a store without rates counts in memory when the app keeps none, and when its store.rates cannot reset, saying so once', async () => {
    const warned = spyOn(log, 'warn').mockImplementation(() => undefined)

    try {
      for (const shared of [undefined, { hit: memoryRates().hit }]) {
        setupStore(shared && { rates: shared })

        const { browser } = await registered(withoutRates())

        await signIn(browser, WRONG)
        await signIn(browser, WRONG)
        expect(await signIn(browser, PASSWORD)).toEqual({ ok: false, error: 'limited' })
      }

      expect(warned.mock.calls.filter(call => String(call[0]).includes('store.rates has no peek or reset'))).toHaveLength(1)
    }
    finally {
      warned.mockRestore()
    }
  })

  test('the store\'s own rates win over the app\'s store.rates', async () => {
    const shared = memoryRates()
    const hit = spyOn(shared, 'hit')

    setupStore({ rates: shared })

    const { browser } = await registered(memoryAuthStore())

    await signIn(browser, WRONG)
    expect(hit).not.toHaveBeenCalled()
  })
})

describe('a rates store that fails', () => {
  const gone = () => {
    throw new Error('the database went away')
  }

  test('counts the attempts in memory when the app\'s store.rates throws, so a sign-in still answers and still locks out, logged once', async () => {
    const warned = spyOn(console, 'warn').mockReturnValue()

    try {
      setupStore({ rates: { hit: gone, peek: gone, reset: gone } })

      const { browser } = await registered(withoutRates())

      await signIn(browser, WRONG)
      expect(await signIn(browser, PASSWORD)).toMatchObject({ ok: true })
      await signIn(browser, WRONG)
      await signIn(browser, WRONG)
      expect(await signIn(browser, PASSWORD)).toEqual({ ok: false, error: 'limited' })
      expect(warned.mock.calls.filter(call => String(call[0]).includes('kayjs-auth'))).toHaveLength(1)
    }
    finally {
      warned.mockRestore()
    }
  })

  test('counts in memory when the auth store\'s own rates reject', async () => {
    const warned = spyOn(console, 'warn').mockReturnValue()
    const rejected = async () => Promise.reject(new Error('the database went away'))

    try {
      const { browser } = await registered({ ...memoryAuthStore(), rates: { hit: rejected, peek: rejected, reset: rejected } })

      await signIn(browser, WRONG)
      await signIn(browser, WRONG)
      expect(await signIn(browser, PASSWORD)).toEqual({ ok: false, error: 'limited' })
    }
    finally {
      warned.mockRestore()
    }
  })

  test('leaves a store that gave up on a slow database alone for a while, counting in memory meanwhile', async () => {
    const warned = spyOn(console, 'warn').mockReturnValue()
    let calls = 0
    const slow = async () => {
      calls++

      throw new TimeoutError('too slow')
    }

    try {
      setupStore({ rates: { hit: slow, peek: slow, reset: slow } })

      const { browser } = await registered(withoutRates())

      await signIn(browser, WRONG)
      await signIn(browser, WRONG)
      expect(await signIn(browser, PASSWORD)).toEqual({ ok: false, error: 'limited' })
      expect(calls).toBe(1)
    }
    finally {
      warned.mockRestore()
    }
  })

  test('counts through the app\'s new store.rates once it is replaced', async () => {
    const first = memoryRates()
    const second = memoryRates()
    const hits = [spyOn(first, 'hit'), spyOn(second, 'hit')]

    setupStore({ rates: first })

    const { browser } = await registered(withoutRates())

    await signIn(browser, WRONG)
    setupStore({ rates: second })
    await signIn(browser, WRONG)
    expect(hits.map(hit => hit.mock.calls.length > 0)).toEqual([true, true])
  })
})

test('the default limits are written as an app writes its own, with a Duration window', () => {
  expect(DEFAULT_LIMITS.signIn).toEqual({ max: 40, window: '15m' })
  expect(DEFAULT_LIMITS.inviteAddress).toEqual({ max: 5, window: '1d' })
})

test('the memory counter drops no open window however many are open, so a flood of keys cannot lift a lockout', () => {
  const rates = memoryAuthRates()

  rates.hit('account', '1h')

  for (let key = 0; key < 20_000; key++)
    rates.hit(`flood-${key}`, '1h')

  expect(rates.peek('account')!.count).toBe(1)
})
