import type { CaptchaOptions } from '../src/captcha'
import type { Mail } from '../src/mail'
import { afterEach, describe, expect, test } from 'bun:test'
import { testApp, userRecord } from './helpers/app'
import { authenticator } from './helpers/authenticator'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const DAY = 24 * 60 * 60
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const HOSTILE = ['https://evil.test/x', '//evil.test', 'javascript:alert(1)', '/\\evil.test']

const asked: string[] = []
const captcha: CaptchaOptions = {
  verify: (token, action) => {
    asked.push(`${action}:${token}`)

    return token === 'human'
  },
}

afterEach(() => {
  asked.length = 0
})

async function setup() {
  const { mails, mailer } = mailbox()
  const app = testApp({ url: 'https://site.test', site: 'Site', captcha, email: { mailer, links: LINKS, requireVerified: false } })

  await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', passwordHash: await Bun.password.hash(PASSWORD) }))

  const tokenOf = (kind: Mail['kind']) => new URL(mails.findLast(mail => mail.kind === kind)!.url!).searchParams.get('token')!

  return { ...app, mails, tokenOf }
}

type Browser = ReturnType<Awaited<ReturnType<typeof setup>>['browser']>

// The session cookie `auth[method](...args)` sets in `browser`.
async function cookieOf(browser: Browser, method: string, ...args: unknown[]): Promise<string | undefined> {
  const response = await browser.fetch(`/call/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })

  return response.headers.getSetCookie().find(line => line.startsWith('session='))
}

// What `auth[method](...args)` answers, the forms of before 1.52 included, which the typed `call` refuses.
async function answer(browser: Browser, method: string, ...args: unknown[]): Promise<unknown> {
  return (await browser.fetch(`/call/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })).json()
}

// Signs `ada` in with a password, the way the methods take it: the identifier and password alone, then the options.
const credentials = { identifier: 'ada@example.com', password: PASSWORD }

describe('signInWithPassword', () => {
  test('takes redirect, remember and captcha as a trailing options object, and the old input fields still work', async () => {
    const { browser } = await setup()

    expect(await browser().call('signInWithPassword', credentials, { redirect: '/account', captcha: 'human' })).toEqual({ ok: true, redirect: '/account' })
    expect(await browser().call('signInWithPassword', { ...credentials, redirect: '/old', captcha: 'human' })).toEqual({ ok: true, redirect: '/old' })
    expect(await browser().call('signInWithPassword', credentials, { captcha: 'bot' })).toEqual({ ok: false, error: 'captcha' })
    expect(await browser().call('signInWithPassword', { ...credentials, captcha: 'bot' })).toEqual({ ok: false, error: 'captcha' })
    expect(asked).toEqual(['sign-in:human', 'sign-in:human', 'sign-in:bot', 'sign-in:bot'])
    expect(await cookieOf(browser(), 'signInWithPassword', credentials, { remember: true, captcha: 'human' })).toContain(`Max-Age=${90 * DAY}`)
    expect(await cookieOf(browser(), 'signInWithPassword', { ...credentials, remember: true, captcha: 'human' })).toContain(`Max-Age=${90 * DAY}`)
    expect(await cookieOf(browser(), 'signInWithPassword', credentials, { remember: false, captcha: 'human' })).not.toContain('Max-Age')
  })

  test('the options object wins over the same field in the input, and a field only in the input stays', async () => {
    const { browser } = await setup()

    expect(await browser().call('signInWithPassword', { ...credentials, redirect: '/old', captcha: 'human' }, { redirect: '/new' })).toEqual({ ok: true, redirect: '/new' })
    expect(await browser().call('signInWithPassword', { ...credentials, redirect: '/old', captcha: 'bot' }, { captcha: 'human' })).toEqual({ ok: true, redirect: '/old' })
    expect(await cookieOf(browser(), 'signInWithPassword', { ...credentials, remember: false, captcha: 'human' }, { remember: true })).toContain(`Max-Age=${90 * DAY}`)
  })

  test.each(HOSTILE)('a redirect of %s leads home, given either way', async (redirect) => {
    const { browser } = await setup()

    expect(await browser().call('signInWithPassword', credentials, { redirect, captcha: 'human' })).toEqual({ ok: true, redirect: '/' })
    expect(await browser().call('signInWithPassword', { ...credentials, redirect, captcha: 'human' })).toEqual({ ok: true, redirect: '/' })
    expect(await browser().call('signInWithPassword', { ...credentials, redirect: '/old', captcha: 'human' }, { redirect })).toEqual({ ok: true, redirect: '/' })
  })
})

describe('register', () => {
  test('takes remember and captcha as a trailing options object, and the old input fields still work', async () => {
    const { browser } = await setup()

    expect(await cookieOf(browser(), 'register', { email: 'bob@example.com', password: PASSWORD }, { remember: true, captcha: 'human' })).toContain(`Max-Age=${90 * DAY}`)
    expect(await cookieOf(browser(), 'register', { email: 'cy@example.com', password: PASSWORD, remember: true, captcha: 'human' })).toContain(`Max-Age=${90 * DAY}`)
    expect(await browser().call('register', { email: 'di@example.com', password: PASSWORD }, { captcha: 'bot' })).toEqual({ ok: false, error: 'captcha' })
    expect(await browser().call('register', { email: 'di@example.com', password: PASSWORD, captcha: 'bot' })).toEqual({ ok: false, error: 'captcha' })
  })

  test('the options object wins over the same field in the input', async () => {
    const { browser } = await setup()

    expect(await cookieOf(browser(), 'register', { email: 'bob@example.com', password: PASSWORD, remember: false, captcha: 'bot' }, { remember: true, captcha: 'human' })).toContain(`Max-Age=${90 * DAY}`)
    expect(await browser().call('register', { email: 'cy@example.com', password: PASSWORD, captcha: 'human' }, { captcha: 'bot' })).toEqual({ ok: false, error: 'captcha' })
  })
})

describe('requestMagicLink', () => {
  async function redirectOf(app: Awaited<ReturnType<typeof setup>>, ...args: unknown[]) {
    const browser = app.browser()

    expect(await answer(browser, 'requestMagicLink', 'ada@example.com', ...args)).toEqual({ ok: true })

    return (await browser.call('signInWithMagicLink', app.tokenOf('magic-link')) as { redirect: string }).redirect
  }

  test('takes redirect, remember and captcha as an options object, and the positional redirect still works', async () => {
    const app = await setup()

    expect(await redirectOf(app, { redirect: '/account', captcha: 'human' })).toBe('/account')
    expect(await redirectOf(app, '/old', { captcha: 'human' })).toBe('/old')
    expect(await redirectOf(app, undefined, { captcha: 'human' })).toBe('/')
    expect(await app.browser().call('requestMagicLink', 'ada@example.com', { captcha: 'bot' })).toEqual({ ok: false, error: 'captcha' })
    expect(await answer(app.browser(), 'requestMagicLink', 'ada@example.com', '/old', { captcha: 'bot' })).toEqual({ ok: false, error: 'captcha' })

    const ada = app.browser()

    await app.store.users.create(userRecord({ id: 'u2', email: 'bob@example.com' }))
    await ada.call('requestMagicLink', 'bob@example.com', { remember: true, captcha: 'human' })
    expect(await cookieOf(ada, 'signInWithMagicLink', app.tokenOf('magic-link'))).toContain(`Max-Age=${90 * DAY}`)
  })

  test('the options object\'s redirect wins over the positional one', async () => {
    const app = await setup()

    expect(await redirectOf(app, '/old', { redirect: '/new', captcha: 'human' })).toBe('/new')
  })

  test.each(HOSTILE)('a redirect of %s leads home, given either way', async (hostile) => {
    const app = await setup()

    expect(await redirectOf(app, { redirect: hostile, captcha: 'human' })).toBe('/')
    expect(await redirectOf(app, hostile, { captcha: 'human' })).toBe('/')
    expect(await redirectOf(app, '/old', { redirect: hostile, captcha: 'human' })).toBe('/')
  })
})

describe('signInWithPasskey', () => {
  async function passkeySetup() {
    const app = await setup()
    const ada = app.browser()
    const device = authenticator()

    await ada.fetch('/sign-in/u1', { method: 'POST' })
    const { options } = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })

    await ada.callOk('registerPasskey', await device.create(options))

    const signIn = async (...args: unknown[]) => {
      const visitor = app.browser()
      const response = await device.get(await visitor.call('passkeySignInOptions'))

      return { visitor, result: await answer(visitor, 'signInWithPasskey', response, ...args) as { ok: boolean, redirect: string } }
    }

    const cookie = async (...args: unknown[]) => {
      const visitor = app.browser()
      const response = await device.get(await visitor.call('passkeySignInOptions'))

      return cookieOf(visitor, 'signInWithPasskey', response, ...args)
    }

    return { signIn, cookie }
  }

  test('takes redirect and remember as an options object, and the positional redirect still works', async () => {
    const { signIn, cookie } = await passkeySetup()

    expect((await signIn({ redirect: '/account' })).result).toEqual({ ok: true, redirect: '/account' })
    expect((await signIn('/old')).result).toEqual({ ok: true, redirect: '/old' })
    expect((await signIn('/old', { remember: false })).result).toEqual({ ok: true, redirect: '/old' })
    expect((await signIn(undefined, { remember: true })).result).toEqual({ ok: true, redirect: '/' })
    expect(await cookie({ remember: true })).toContain(`Max-Age=${90 * DAY}`)
    expect(await cookie('/old', { remember: true })).toContain(`Max-Age=${90 * DAY}`)
    expect(await cookie({ remember: false })).not.toContain('Max-Age')
  })

  test('the options object\'s redirect wins over the positional one', async () => {
    const { signIn } = await passkeySetup()

    expect((await signIn('/old', { redirect: '/new' })).result).toEqual({ ok: true, redirect: '/new' })
  })

  test.each(HOSTILE)('a redirect of %s leads home, given either way', async (hostile) => {
    const { signIn } = await passkeySetup()

    expect((await signIn({ redirect: hostile })).result).toEqual({ ok: true, redirect: '/' })
    expect((await signIn(hostile)).result).toEqual({ ok: true, redirect: '/' })
    expect((await signIn('/old', { redirect: hostile })).result).toEqual({ ok: true, redirect: '/' })
  })
})
