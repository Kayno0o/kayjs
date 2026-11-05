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

  test('a store without rates counts in memory when the app keeps none, and in an app store.rates with only hit, warning of nothing', async () => {
    const warned = spyOn(log, 'warn').mockImplementation(() => undefined)

    try {
      for (const shared of [undefined, { hit: memoryRates().hit }]) {
        setupStore(shared && { rates: shared })

        const { browser } = await registered(withoutRates())

        await signIn(browser, WRONG)
        await signIn(browser, WRONG)
        expect(await signIn(browser, PASSWORD)).toEqual({ ok: false, error: 'limited' })
      }

      expect(warned).not.toHaveBeenCalled()
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

  rates.hit('account', 3_600_000)

  for (let key = 0; key < 20_000; key++)
    rates.hit(`flood-${key}`, 3_600_000)

  expect(rates.peek('account')!.count).toBe(1)
})

describe('two auth instances', () => {
  test('keep the attempts they count in memory apart when the app\'s store fails', async () => {
    const warned = spyOn(console, 'warn').mockReturnValue()
    const gone = () => {
      throw new Error('the database went away')
    }

    try {
      setupStore({ rates: { hit: gone } })

      const first = await registered(withoutRates())
      const second = await registered(withoutRates())

      await signIn(first.browser, WRONG)
      await signIn(first.browser, WRONG)
      expect(await signIn(first.browser, PASSWORD)).toEqual({ ok: false, error: 'limited' })
      expect(await signIn(second.browser, PASSWORD)).toMatchObject({ ok: true })
    }
    finally {
      warned.mockRestore()
    }
  })
})

describe('a bucket of rateLimit', () => {
  test('takes a list, each limit counted apart and any refusing', async () => {
    const app = testApp({ rateLimit: { register: [{ max: 5, window: '1h' }, { max: 2, window: '1d' }] } })
    const answers: unknown[] = []

    for (let n = 0; n < 3; n++)
      answers.push(await app.browser().post('/register', { email: `ada${n}@example.com`, password: PASSWORD }))

    expect(answers[2]).toEqual({ ok: false, error: 'limited' })
  })

  test('counts in the store of its own', async () => {
    const own = memoryRates()
    const hit = spyOn(own, 'hit')
    const app = testApp({ rateLimit: { register: { max: 5, window: '1h', store: own } } })

    await app.browser().post('/register', { email: 'ada@example.com', password: PASSWORD })

    expect(hit).toHaveBeenCalled()
  })

  test('refuses an empty list and a store that cannot count', () => {
    expect(() => testApp({ rateLimit: { register: [] } })).toThrow('empty list')
    expect(() => testApp({ rateLimit: { register: { max: 1, window: '1h', store: {} as never } } })).toThrow('hit(key, window)')
  })
})
