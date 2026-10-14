import type { CaptchaOptions } from '../src/captcha'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { pwnedPassword } from '../src/breached'
import { hcaptcha, proofOfWork, turnstile, turnstileWidget } from '../src/captcha'
import { testApp, userRecord } from './helpers/app'
import { mailbox } from './helpers/mail'
import { difficultyOf, solve } from './helpers/work'

const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  setSystemTime()
})

function setup(options: Parameters<typeof testApp>[0] = {}) {
  const { mails, mailer, take } = mailbox()
  const app = testApp({
    url: 'https://site.test',
    email: {
      mailer,
      links: LINKS,
      requireVerified: false,
    },
    ...options,
  })

  return { ...app, mails, take }
}

// A check passing only the token `human`, recording what it was asked.
function checker(on?: CaptchaOptions['on']) {
  const asked: string[] = []
  const captcha: CaptchaOptions = {
    verify: (token, action) => {
      asked.push(`${action}:${token}`)

      return token === 'human'
    },
    on,
  }

  return { captcha, asked }
}

describe('a CAPTCHA', () => {
  test('is asked of registering, password sign-in, resets and magic links, a missing token never reaching the check', async () => {
    const { captcha, asked } = checker()
    const { browser, store } = setup({ captcha })
    const ada = browser()

    await store.users.create(userRecord({ id: 'u1', email: 'bob@example.com' }))

    expect(await ada.post('/register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'captcha' })
    expect(await ada.post('/register', { email: 'ada@example.com', password: PASSWORD, captcha: 'bot' })).toEqual({ ok: false, error: 'captcha' })
    expect(await ada.post('/register', { email: 'ada@example.com', password: PASSWORD, captcha: 'human' })).toMatchObject({ ok: true })
    expect(await ada.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'captcha' })
    expect(await ada.post('/password', { identifier: 'ada@example.com', password: PASSWORD, captcha: 'human' })).toMatchObject({ ok: true })
    expect(await ada.call('requestPasswordReset', 'bob@example.com')).toEqual({ ok: false, error: 'captcha' })
    expect(await ada.call('requestPasswordReset', 'bob@example.com', { captcha: 'human' })).toEqual({ ok: true })
    expect(await ada.call('requestMagicLink', 'bob@example.com', '/', { captcha: 'bot' })).toEqual({ ok: false, error: 'captcha' })
    expect(await ada.call('requestMagicLink', 'bob@example.com', '/', { captcha: 'human' })).toEqual({ ok: true })
    expect(asked).toEqual(['register:bot', 'register:human', 'sign-in:human', 'reset:human', 'magic-link:bot', 'magic-link:human'])
  })

  test('set per request, is asked only once the client made that many attempts, and only where configured', async () => {
    const { captcha } = checker({ 'sign-in': 2, 'reset': false })
    const { browser, store } = setup({ captcha })
    const ada = browser()

    await store.users.create(userRecord({ id: 'u1', email: 'bob@example.com' }))

    expect(await ada.call('captchaRequired', 'sign-in')).toBe(false)
    expect(await ada.post('/password', { identifier: 'bob@example.com', password: 'wrong password' })).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.post('/password', { identifier: 'bob@example.com', password: 'wrong password' })).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.call('captchaRequired', 'sign-in')).toBe(true)
    expect(await ada.post('/password', { identifier: 'bob@example.com', password: 'wrong password' })).toEqual({ ok: false, error: 'captcha' })
    expect(await ada.call('captchaRequired', 'reset')).toBe(false)
    expect(await ada.call('requestPasswordReset', 'bob@example.com')).toEqual({ ok: true })
    expect(await ada.call('captchaRequired', 'register')).toBe(true)
    expect(await browser().call('captchaRequired', 'sign-in')).toBe(true)
  })

  test('is never asked with `captcha: false`', async () => {
    const { browser } = setup()

    expect(await browser().call('captchaRequired', 'register')).toBe(false)
  })

  test('a check that throws refuses', async () => {
    const { browser } = setup({ captcha: { verify: () => {
      throw new Error('down')
    } } })

    expect(await browser().post('/register', { email: 'ada@example.com', password: PASSWORD, captcha: 'human' })).toEqual({ ok: false, error: 'captcha' })
  })

  test('the Turnstile and hCaptcha presets post the secret and the token to their service', async () => {
    const posted: string[] = []

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      posted.push(`${input} ${String(init?.body)}`)

      return Response.json({ success: String(init?.body).includes('response=good') })
    }) as typeof fetch

    expect(await turnstile('s1')('good', 'register')).toBe(true)
    expect(await hcaptcha('s2')('bad', 'register')).toBe(false)
    expect(posted).toEqual([
      'https://challenges.cloudflare.com/turnstile/v0/siteverify secret=s1&response=good',
      'https://api.hcaptcha.com/siteverify secret=s2&response=bad',
    ])
  })
})

describe('the proof-of-work CAPTCHA', () => {
  test('is the default: registering, resets and magic links ask always, a password sign-in from the third attempt', async () => {
    const { browser, store } = setup({ captcha: undefined })
    const ada = browser()

    await store.users.create(userRecord({ id: 'u1', email: 'bob@example.com' }))

    expect(await ada.post('/register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'captcha' })
    expect(await ada.post('/register', { email: 'ada@example.com', password: PASSWORD, captcha: solve(await ada.call('captchaChallenge', 'register')) })).toMatchObject({ ok: true })
    expect(await ada.call('requestPasswordReset', 'bob@example.com')).toEqual({ ok: false, error: 'captcha' })
    expect(await ada.call('requestPasswordReset', 'bob@example.com', { captcha: solve(await ada.call('captchaChallenge', 'reset')) })).toEqual({ ok: true })
    expect(await ada.call('requestMagicLink', 'bob@example.com', '/', { captcha: solve(await ada.call('captchaChallenge', 'magic-link')) })).toEqual({ ok: true })

    // An app often signs a guest in with no form to carry a challenge.
    expect(await browser().call('signInAsGuest')).toMatchObject({ ok: true, user: { guest: true } })

    const grace = browser()

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await grace.call('captchaChallenge', 'sign-in')).toBeFalsy()
      expect(await grace.post('/password', { identifier: 'bob@example.com', password: 'wrong password' })).toEqual({ ok: false, error: 'invalid' })
    }

    expect(await grace.post('/password', { identifier: 'bob@example.com', password: 'wrong password' })).toEqual({ ok: false, error: 'captcha' })
    expect(await grace.post('/password', { identifier: 'bob@example.com', password: 'wrong password', captcha: solve(await grace.call('captchaChallenge', 'sign-in')) })).toEqual({ ok: false, error: 'invalid' })
  })

  test('doubles its difficulty with each attempt past the threshold, up to 16 times, an easier challenge then refused', async () => {
    const { browser } = setup({ captcha: proofOfWork({ difficulty: 20 }) })
    const ada = browser()
    const first = await ada.call('captchaChallenge', 'register')
    const difficulties: number[] = []

    expect(await ada.post('/register', { email: 'ada@example.com', password: 'short', captcha: solve(first) })).toMatchObject({ ok: false, errors: { password: 'too-short' } })

    for (let attempt = 0; attempt < 5; attempt++) {
      const challenge = await ada.call('captchaChallenge', 'register')

      difficulties.push(difficultyOf(challenge))

      if (attempt < 4)
        await ada.post('/register', { email: 'ada@example.com', password: 'short', captcha: solve(challenge) })
    }

    expect(difficultyOf(first)).toBe(20)
    expect(difficulties).toEqual([40, 80, 160, 320, 320])
    expect(await ada.post('/register', { email: 'ada@example.com', password: PASSWORD, captcha: solve(first) })).toEqual({ ok: false, error: 'captcha' })
  })

  test('refuses a solution replayed, past its maxAge or solving another action\'s challenge', async () => {
    const { browser } = setup({ captcha: proofOfWork({ difficulty: 20, maxAge: '10m', on: { 'sign-in': 'always' } }) })
    const ada = browser()
    const solved = solve(await ada.call('captchaChallenge', 'sign-in'))

    expect(await ada.post('/register', { email: 'ada@example.com', password: PASSWORD, captcha: solved })).toEqual({ ok: false, error: 'captcha' })
    expect(await ada.post('/password', { identifier: 'nobody@example.com', password: PASSWORD, captcha: solved })).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.post('/password', { identifier: 'nobody@example.com', password: PASSWORD, captcha: solved })).toEqual({ ok: false, error: 'captcha' })

    const later = solve(await browser().call('captchaChallenge', 'sign-in'))

    setSystemTime(Date.now() + 11 * 60 * 1000)

    expect(await browser().post('/password', { identifier: 'nobody@example.com', password: PASSWORD, captcha: later })).toEqual({ ok: false, error: 'captcha' })
  })

  test('of a third party asks a guest sign-in as it asks registering, unless told otherwise', async () => {
    const { captcha, asked } = checker({ register: 'always' })

    expect(await setup({ captcha }).browser().call('signInAsGuest')).toEqual({ ok: false, error: 'captcha' })
    expect(await setup({ captcha }).browser().call('signInAsGuest', { captcha: 'human' })).toMatchObject({ ok: true })
    expect(asked).toEqual(['guest:human'])
    expect(await setup({ captcha: checker({ register: 'always', guest: false }).captcha }).browser().call('signInAsGuest')).toMatchObject({ ok: true })
  })

  test('refuses a difficulty kay could not take once doubled to its most, when configured rather than on the first page', () => {
    for (const difficulty of [0, 1.5, Number.NaN, 62_500_001])
      expect(() => proofOfWork({ difficulty })).toThrow('it takes a whole number from 1 to 62500000')

    expect(proofOfWork({ difficulty: 62_500_000 }).proofOfWork.difficulty).toBe(62_500_000)
  })

  test('is reported by features(), as a widget is', async () => {
    expect((await setup({ captcha: undefined }).browser().call('features')).captcha).toBe('proof-of-work')
    expect((await setup({ captcha: { verify: () => true, widget: turnstileWidget('key') } }).browser().call('features')).captcha).toMatchObject({ siteKey: 'key' })
    expect((await setup().browser().call('features')).captcha).toBeNull()
    expect(await setup({ captcha: { verify: () => true } }).browser().call('captchaChallenge', 'register')).toBeFalsy()
  })
})

describe('breached passwords', () => {
  const breached = (password: string) => password === 'password1234'

  test('are refused on registering, resetting and changing a password', async () => {
    const { browser, take } = setup({ breachedPasswords: breached })
    const ada = browser()

    expect(await ada.post('/register', { email: 'ada@example.com', password: 'password1234' })).toEqual({ ok: false, errors: { password: 'breached' } })
    expect(await ada.post('/register', { email: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await ada.call('changePassword', { password: PASSWORD }, 'password1234')).toEqual({ ok: false, errors: { password: 'breached' } })

    await ada.call('requestPasswordReset', 'ada@example.com')
    const [reset] = await take({ kind: 'reset-password' })
    const token = new URL(reset!.url!).searchParams.get('token')!

    expect(await ada.call('resetPassword', token, 'password1234')).toEqual({ ok: false, errors: { password: 'breached' } })
    // The refused password left the link usable.
    expect(await ada.call('resetPassword', token, 'another good password')).toMatchObject({ ok: true })
  })

  test('a check that throws lets the password through', async () => {
    const { browser } = setup({ breachedPasswords: () => {
      throw new Error('down')
    } })

    expect(await browser().post('/register', { email: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
  })

  test('Have I Been Pwned is asked for the first five characters of the SHA-1 only, decoys not counting', async () => {
    const hash = createHash('sha1').update('password1234').digest('hex').toUpperCase()
    const asked: string[] = []

    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      asked.push(`${input} ${new Headers(init?.headers).get('add-padding')}`)

      return new Response(`0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${hash.slice(5)}:${input.endsWith(hash.slice(0, 5)) ? 3 : 0}\r\n`)
    }) as typeof fetch

    expect(await pwnedPassword('password1234')).toBe(true)
    expect(asked).toEqual([`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)} true`])

    globalThis.fetch = (async () => new Response(`${hash.slice(5)}:0\r\n`)) as unknown as typeof fetch

    expect(await pwnedPassword('password1234')).toBe(false)
  })

  test('`true` checks Have I Been Pwned, and an outage lets the password through', async () => {
    globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch

    const { browser } = setup({ breachedPasswords: true })

    expect(await browser().post('/register', { email: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
  })
})
