import type { CaptchaOptions } from '../src/captcha'
import type { Mail } from '../src/mail'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, test } from 'bun:test'
import { pwnedPassword } from '../src/breached'
import { hcaptcha, turnstile } from '../src/captcha'
import { testApp, userRecord } from './helpers/app'

const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function setup(options: Parameters<typeof testApp>[0] = {}) {
  const mails: Mail[] = []
  const app = testApp({
    url: 'https://site.test',
    email: {
      mailer: {
        send: (mail) => {
          mails.push(mail)
        },
      },
      links: LINKS,
    },
    ...options,
  })

  return { ...app, mails }
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

  test('is never asked without one configured', async () => {
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

describe('breached passwords', () => {
  const breached = (password: string) => password === 'password1234'

  test('are refused on registering, resetting and changing a password', async () => {
    const { browser, mails } = setup({ breachedPasswords: breached })
    const ada = browser()

    expect(await ada.post('/register', { email: 'ada@example.com', password: 'password1234' })).toEqual({ ok: false, errors: { password: 'breached' } })
    expect(await ada.post('/register', { email: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await ada.call('changePassword', { password: PASSWORD }, 'password1234')).toEqual({ ok: false, errors: { password: 'breached' } })

    await ada.call('requestPasswordReset', 'ada@example.com')
    await Bun.sleep(10)
    const token = new URL(mails.findLast(mail => mail.kind === 'reset-password')!.url!).searchParams.get('token')!

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
