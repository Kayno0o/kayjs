import type { Mail } from '../src/mail'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { discordProvider, githubProvider } from '../src/oauth/providers'
import { authPages } from '../src/pages'
import { scopeLabel } from '../src/pages/forms'
import { totpCode, totpStep } from '../src/totp'
import { testApp, userRecord } from './helpers/app'

const PASSWORD = 'correct horse battery'
const LATER = 11 * 60_000

const mailer = (mails: Mail[]) => ({ send: (mail: Mail) => void mails.push(mail) })

describe('createAuth with the prebuilt pages', () => {
  test('the sign-in, two-factor and sessions pages and every mailed link default to the pages under their prefix', async () => {
    const mails: Mail[] = []
    const { browser, store } = testApp({ url: 'http://localhost', pages: authPages({ prefix: '/account-pages' }), oauth: { discord: { provider: discordProvider(), clientId: 'id', clientSecret: 'secret' } }, email: { mailer: mailer(mails), links: { 'magic-link': '/magic' }, requireVerified: false } })
    const ada = browser()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))
    await ada.call('requestPasswordReset', 'ada@example.com')
    await ada.call('requestMagicLink', 'ada@example.com')

    expect(mails.map(mail => new URL(mail.url!).pathname)).toEqual(['/account-pages/reset-password', '/magic'])
    expect(await ada.call('features')).toMatchObject({ pages: { prefix: '/account-pages', home: '/' } })

    // A callback with no flow started fails, back to the sign-in page.
    expect((await ada.fetch('/auth/discord/callback?code=x&state=y')).headers.get('location')).toStartWith('/account-pages/sign-in?error=')
  })

  test('without pages, a mailed link with no page of its own stops createAuth', () => {
    expect(() => testApp({ url: 'http://localhost', email: { mailer: mailer([]), links: { 'magic-link': '/magic' } } })).toThrow('email.links needs a page for verify-email, reset-password, change-email')
    expect(() => testApp({ url: 'http://localhost', pages: true, email: { mailer: mailer([]) } })).not.toThrow()
  })
})

describe('features', () => {
  test('tells a page what the config enables', async () => {
    const { browser } = testApp({
      url: 'http://localhost',
      scopes: ['posts:read'],
      oauth: { github: { provider: githubProvider(), clientId: 'id', clientSecret: 'secret' }, chat: { provider: discordProvider(), clientId: 'id', clientSecret: 'secret', label: 'Our chat' } },
      email: { mailer: mailer([]), links: { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }, codes: { 'magic-link': 'code' } },
    })

    expect(await browser().call('features')).toEqual({
      providers: [{ name: 'github', label: 'GitHub' }, { name: 'chat', label: 'Our chat' }],
      email: true,
      codes: { 'magic-link': 'code', 'verify-email': 'link' },
      signUp: true,
      requireVerified: true,
      passkeys: true,
      captcha: null,
      scopes: ['posts:read'],
      prefix: '/auth',
      oauthServer: false,
      signInPage: '/',
      pages: null,
      rules: { password: { min: 10, max: 128 }, username: { min: 2, max: 32 } },
    })
  })

  test('says what is missing without mail, providers or a url', async () => {
    expect(await testApp().browser().call('features')).toMatchObject({ providers: [], email: false, codes: null, passkeys: false, scopes: [] })
  })
})

describe('the data export route', () => {
  test('downloads the signed-in user\'s data as JSON, and refuses an anonymous visitor', async () => {
    const { browser, store } = testApp({ site: 'My Site' })
    const ada = browser()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))

    expect((await ada.fetch('/auth/export')).status).toBe(401)

    await ada.fetch('/sign-in/u1', { method: 'POST' })

    const response = await ada.fetch('/auth/export')

    expect(response.headers.get('content-disposition')).toBe('attachment; filename="My-Site-data.json"')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ user: { id: 'u1', email: 'ada@example.com' } })
  })
})

afterEach(() => {
  setSystemTime()
})

describe('exporting a user\'s data', () => {
  test('gives what kayjs-auth keeps about the user, no secret among it, with the app\'s own', async () => {
    const { browser, store } = testApp({ audit: true, onExport: user => ({ posts: [`by ${user.email}`] }) })
    const ada = browser()
    const { user } = await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })

    await ada.call('createToken', { password: PASSWORD }, 'Phone')
    await store.identities.create({ provider: 'discord', providerId: '42', userId: user.id, accessToken: 'sealed-access', refreshToken: 'sealed-refresh', tokenExpiresAt: null, createdAt: new Date() })

    const exported = await ada.callOk('exportData')
    const text = JSON.stringify(exported)

    expect(exported).toMatchObject({
      ok: true,
      data: {
        user: { id: user.id, email: 'ada@example.com', hasPassword: true, twoFactorEnabledAt: null },
        identities: [{ provider: 'discord', providerId: '42' }],
        sessions: [{ current: true }],
        passkeys: [],
        tokens: [{ label: 'Phone' }],
        recoveryCodesLeft: 0,
        app: { posts: ['by ada@example.com'] },
      },
    })
    expect(exported.data.audit.map((entry: { event: string }) => entry.event)).toContain('signed-in')

    for (const secret of ['passwordHash', 'sealed-access', 'sealed-refresh', 'digest', 'totpSecret', (await store.users.get(user.id))!.passwordHash!])
      expect(text).not.toContain(secret)
  })

  test('needs a session', async () => {
    const { browser } = testApp()

    expect(await browser().call('exportData')).toEqual({ ok: false, error: 'signed-out' })
  })

  test('counts each export, the download included, against the account\'s limit', async () => {
    const { browser } = testApp({ limits: { export: { max: 2, window: 3600 } } })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect((await ada.call('exportData')).ok).toBe(true)
    expect((await ada.fetch('/auth/export')).status).toBe(200)
    expect(await ada.call('exportData')).toEqual({ ok: false, error: 'limited' })
    expect((await ada.fetch('/auth/export')).status).toBe(429)
  })

  describe('needs a sign-in or a proof under ten minutes old, so a stolen session downloads nothing', () => {
    test('a stale session is refused by the method and the route, neither counting against the limit', async () => {
      const { browser } = testApp({ limits: { export: { max: 1, window: 3600 } } })
      const ada = browser()

      await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
      setSystemTime(new Date(Date.now() + LATER))

      expect(await ada.call('exportData')).toEqual({ ok: false, error: 'stale' })

      const response = await ada.fetch('/auth/export')

      expect(response.status).toBe(403)
      expect(response.headers.get('content-disposition')).toBeNull()

      await ada.call('reprove', { password: PASSWORD })

      expect((await ada.call('exportData')).ok).toBe(true)
    })

    test('a wrong proof leaves it refused, a right one opens the route again', async () => {
      const { browser } = testApp()
      const ada = browser()

      await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
      setSystemTime(new Date(Date.now() + LATER))

      expect(await ada.call('reprove', { password: 'wrong password' })).toEqual({ ok: false, error: 'proof' })
      expect((await ada.fetch('/auth/export')).status).toBe(403)
      expect(await ada.call('provedLately')).toBe(false)

      await ada.call('reprove', { password: PASSWORD })

      expect(await ada.call('provedLately')).toBe(true)
      expect((await ada.fetch('/auth/export')).status).toBe(200)
    })

    test('an account with neither a password nor a second factor can only sign in again', async () => {
      const { browser, store } = testApp()
      const ada = browser()

      await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
      await ada.fetch('/sign-in/u1', { method: 'POST' })

      expect((await ada.call('exportData')).ok).toBe(true)
      setSystemTime(new Date(Date.now() + LATER))

      expect(await ada.call('exportData')).toEqual({ ok: false, error: 'stale' })
      expect(await ada.call('reprove', {})).toEqual({ ok: false, error: 'stale' })
      expect((await ada.fetch('/auth/export')).status).toBe(403)
    })

    test('an account with a second factor stays refused after a wrong code, and opens again once proved', async () => {
      const { browser } = testApp()
      const ada = browser()

      await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

      const { setup } = await ada.callOk('setUpTwoFactor', { password: PASSWORD })

      await ada.call('enableTwoFactor', await totpCode(setup.secret, totpStep()))
      setSystemTime(new Date(Date.now() + LATER))

      expect(await ada.call('exportData')).toEqual({ ok: false, error: 'stale' })
      expect(await ada.call('reprove', { code: '000000' })).toEqual({ ok: false, error: 'proof' })
      expect(await ada.call('exportData')).toEqual({ ok: false, error: 'stale' })

      await ada.call('reprove', { password: PASSWORD })

      expect((await ada.call('exportData')).ok).toBe(true)
    })

    test('a signed-out visitor still gets signed-out, not stale', async () => {
      const { browser } = testApp()

      setSystemTime(new Date(Date.now() + LATER))

      expect(await browser().call('exportData')).toEqual({ ok: false, error: 'signed-out' })
    })
  })
})

describe('scopeLabel', () => {
  test('a scope no catalog words reads as itself, whatever it holds', () => {
    expect(scopeLabel('posts:read')).toBe('posts:read')
    expect(scopeLabel('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
    expect(scopeLabel('{count}')).toBe('{count}')
  })
})
