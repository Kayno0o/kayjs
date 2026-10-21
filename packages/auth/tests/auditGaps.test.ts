import type { LimitsOption } from '../src/limits'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { hcaptcha, turnstile } from '../src/captcha'
import { createOAuthClient } from '../src/oauth/client'
import { discordProvider, githubProvider, oidcProvider } from '../src/oauth/providers'
import { base32Encode } from '../src/totp'
import { sealTotpSecret } from '../src/twoFactor'
import { SECRET, testApp, userRecord } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const realFetch = globalThis.fetch
const realEnv = process.env.NODE_ENV ?? 'test'

afterEach(() => {
  globalThis.fetch = realFetch
  process.env.NODE_ENV = realEnv
})

describe('emailed codes', () => {
  test('five misses from another session\'s nonce leave the holder\'s live code working', async () => {
    const { mailer, take } = mailbox()
    const { browser, store } = testApp({ url: 'https://site.test', email: { mailer, links: LINKS, codes: 'code' } })

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))

    const thief = browser()
    const ada = browser()

    await thief.call('requestMagicLink', 'ada@example.com')
    await ada.call('requestMagicLink', 'ada@example.com')

    const [, mail] = await take({ kind: 'magic-link' }, 2)
    const code = mail!.code!

    for (let miss = 0; miss < 6; miss++)
      await thief.call('signInWithEmailCode', code === '000000' ? '111111' : '000000')

    expect(await ada.call('signInWithEmailCode', code)).toMatchObject({ ok: true })
  })
})

describe('resetting a password', () => {
  test('a stream of forged links does not reach the breached-password service past the link limit', async () => {
    const asked: string[] = []
    const { browser } = testApp({
      url: 'https://site.test',
      rateLimit: { link: { max: 2, window: '900s' } } satisfies LimitsOption,
      email: { mailer: mailbox().mailer, links: LINKS },
      breachedPasswords: (password) => {
        asked.push(password)

        return false
      },
    })
    const visitor = browser()

    for (let i = 0; i < 6; i++)
      await visitor.call('resetPassword', 'forged', PASSWORD)

    expect(asked.length).toBeLessThanOrEqual(2)
    expect(await visitor.call('resetPassword', 'forged', PASSWORD)).toEqual({ ok: false, error: 'limited' })
  })

  test('a refused password still leaves the link usable', async () => {
    const { mailer, take } = mailbox()
    const { browser, store } = testApp({ url: 'https://site.test', email: { mailer, links: LINKS }, breachedPasswords: password => password === 'known breached one' })

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))
    await browser().call('requestPasswordReset', 'ada@example.com')

    const token = new URL((await take({ kind: 'reset-password' }))[0]!.url!).searchParams.get('token')!
    const visitor = browser()

    expect(await visitor.call('resetPassword', token, 'known breached one')).toEqual({ ok: false, errors: { password: 'breached' } })
    expect(await visitor.call('resetPassword', token, PASSWORD)).toMatchObject({ ok: true })
  })
})

describe('the second factor cap', () => {
  test('mails the holder once when the account has had too many guesses', async () => {
    const box = mailbox()
    const app = testApp({ rateLimit: { twoFactorAccount: { max: 3, window: '900s' } }, url: 'https://site.test', email: { mailer: box.mailer, links: LINKS, requireVerified: false } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })

    const user = (await app.store.users.findByEmail('ada@example.com'))!
    const secret = base32Encode(new TextEncoder().encode('a-plain-legacy-secret'))

    await app.store.users.update(user.id, { emailVerifiedAt: new Date(), totpSecret: sealTotpSecret(SECRET, user.id, secret), totpEnabledAt: new Date() })

    const visitor = app.browser()

    await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    const answers: unknown[] = []

    for (let i = 0; i < 7; i++)
      answers.push(await visitor.call('verifyTwoFactor', '000000'))

    expect(answers.at(-1)).toEqual({ ok: false, error: 'limited' })
    await Bun.sleep(20)
    expect(box.mails.filter(mail => mail.kind === 'sign-in-locked')).toHaveLength(1)
    expect(box.mails.filter(mail => mail.kind === 'sign-in-locked')[0]!.to).toBe('ada@example.com')
  })
})

describe('OAuth', () => {
  function oauthApp() {
    return testApp({
      url: 'https://site.test',
      signInPage: '/login',
      oauth: {
        discord: { provider: discordProvider(), clientId: 'discord-id', clientSecret: 's' },
        github: { provider: githubProvider(), clientId: 'github-id', clientSecret: 's' },
      },
    })
  }

  const stateOf = (response: Response) => new URL(response.headers.get('location')!).searchParams.get('state')

  test('a plain GET while a sign-in is in flight does not change its state, so the callback still lands', async () => {
    const { browser } = oauthApp()
    const visitor = browser()
    const first = stateOf(await visitor.fetch('/auth/discord?redirect=/account'))
    const again = stateOf(await visitor.fetch('/auth/discord?redirect=/account'))

    expect(again).toBe(first)
  })

  test('a GET never replaces a provider link in flight', async () => {
    const { browser, store } = oauthApp()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', passwordHash: await Bun.password.hash(PASSWORD) }))

    const ada = browser()

    await ada.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    const started = await ada.callOk('linkProvider', 'discord', { password: PASSWORD })
    const linkState = new URL(started.url).searchParams.get('state')

    const intruder = await ada.fetch('/auth/github')

    expect(intruder.headers.get('location')).toBe('/login?error=oauth')

    const callback = await ada.fetch(`/auth/discord/callback?error=access_denied&state=${linkState}`)

    expect(callback.headers.get('location')).toBe('/login?error=cancelled')

    // Signed out, an abandoned link no longer blocks signing in with a provider.
    await ada.callOk('linkProvider', 'discord', { password: PASSWORD })
    await ada.call('signOut')
    expect((await ada.fetch('/auth/github')).headers.get('location')).toContain('github.com')
  })

  test('a failed token exchange is logged', async () => {
    const { browser } = oauthApp()
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const visitor = browser()

    globalThis.fetch = (async () => new Response('no', { status: 400 })) as unknown as typeof fetch

    try {
      const state = stateOf(await visitor.fetch('/auth/discord'))
      const back = await visitor.fetch(`/auth/discord/callback?code=x&state=${state}`)

      expect(back.headers.get('location')).toBe('/login?error=oauth')
      expect(warn.mock.calls.flat().join(' ')).toContain('discord')
    }
    finally {
      warn.mockRestore()
    }
  })

  test('an https site refuses a provider endpoint on plain http whatever NODE_ENV says', () => {
    process.env.NODE_ENV = 'development'

    expect(() => testApp({ url: 'https://site.test', oauth: { github: { provider: githubProvider({ url: 'http://git.example.com' }), clientId: 'a', clientSecret: 'b' } } })).toThrow('not https')
    expect(() => testApp({ url: 'http://localhost:3000', oauth: { github: { provider: githubProvider({ url: 'http://git.example.com' }), clientId: 'a', clientSecret: 'b' } } })).not.toThrow()
  })

  test('an http OpenID Connect issuer is refused at an https site outside production too', () => {
    process.env.NODE_ENV = 'development'

    expect(() => testApp({ url: 'https://site.test', oauth: { idp: { provider: oidcProvider({ issuer: 'http://idp.test' }), clientId: 'a', clientSecret: 'b' } } })).toThrow('not https')
  })

  test('a discovered endpoint on plain http is refused for an https site', async () => {
    const provider = { ...discordProvider(), discover: async () => ({ tokenUrl: 'http://idp.test/token' }) }
    const client = createOAuthClient(provider, { clientId: 'a', redirectUri: 'https://site.test/auth/discord/callback' })

    await expect(client.exchangeCode('x', {})).rejects.toThrow('https')
  })
})

describe('CAPTCHA siteverify', () => {
  function answer(body: Record<string, unknown>) {
    globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch
  }

  const context = { hostname: 'site.test' }

  test('Turnstile must name the site\'s hostname and the action asked for', async () => {
    const check = turnstile('s')

    answer({ success: true, hostname: 'site.test', action: 'register' })
    expect(await check('t', 'register', context)).toBe(true)
    answer({ success: true, hostname: 'evil.test', action: 'register' })
    expect(await check('t', 'register', context)).toBe(false)
    answer({ success: true, hostname: 'site.test', action: 'sign-in' })
    expect(await check('t', 'register', context)).toBe(false)
    answer({ success: true, hostname: 'site.test' })
    expect(await check('t', 'register', context)).toBe(true)
  })

  test('hCaptcha must name the site\'s hostname', async () => {
    const check = hcaptcha('s')

    answer({ success: true, hostname: 'site.test' })
    expect(await check('t', 'register', context)).toBe(true)
    answer({ success: true, hostname: 'evil.test' })
    expect(await check('t', 'register', context)).toBe(false)
  })

  test('the documented test secrets are not held to the site\'s hostname or action', async () => {
    answer({ success: true, hostname: 'localhost', action: 'test' })
    expect(await turnstile('1x0000000000000000000000000000000AA')('t', 'register', { hostname: 'site.test' })).toBe(true)
    answer({ success: true, hostname: 'dummy-key-pass' })
    expect(await hcaptcha('0x0000000000000000000000000000000000000000')('t', 'register', { hostname: 'site.test' })).toBe(true)
    answer({ success: false, hostname: 'localhost' })
    expect(await turnstile('2x0000000000000000000000000000000AA')('t', 'register', { hostname: 'site.test' })).toBe(false)
    answer({ success: true, hostname: 'localhost', action: 'test' })
    expect(await turnstile('a-real-secret')('t', 'register', { hostname: 'site.test' })).toBe(false)
  })

  test('a dev site on localhost passes with the hostname the provider reports', async () => {
    answer({ success: true, hostname: 'localhost', action: 'register' })
    expect(await turnstile('a-real-secret')('t', 'register', { hostname: 'localhost' })).toBe(true)
  })

  test('a token is checked without a hostname when the app has no url', async () => {
    answer({ success: true, hostname: 'anything.test' })
    expect(await turnstile('s')('t', 'register')).toBe(true)
  })
})
