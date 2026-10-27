import type { AuthStore } from '../src/store'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { memoryRates } from 'kay/server'
import { setupStore } from '../../../src/server/app-store'
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

  test('a store giving the attempts counter of before 1.81 is still counted and cleared through it', async () => {
    const memory = memoryAuthRates()
    const calls: string[] = []
    const store: AuthStore = {
      ...withoutRates(),
      attempts: {
        count: async (key) => {
          calls.push('count')

          return (await memory.peek(key))?.count ?? 0
        },
        hit: async (key, window) => {
          calls.push('hit')

          return memory.hit(key, window).count
        },
        reset: (key) => {
          calls.push('reset')
          memory.reset(key)
        },
      },
    }
    const { browser } = await registered(store)

    await signIn(browser, WRONG)
    expect(await signIn(browser, PASSWORD)).toMatchObject({ ok: true })
    await signIn(browser, WRONG)
    await signIn(browser, WRONG)
    expect(await signIn(browser, PASSWORD)).toEqual({ ok: false, error: 'limited' })
    expect(new Set(calls)).toEqual(new Set(['count', 'hit', 'reset']))
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
