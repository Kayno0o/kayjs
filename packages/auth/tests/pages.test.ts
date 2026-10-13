import type { Mail } from '../src/mail'
import { describe, expect, test } from 'bun:test'
import { discordProvider, githubProvider } from '../src/oauth/providers'
import { authPages } from '../src/pages'
import { testApp, userRecord } from './helpers/app'

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
      signInPage: '/',
      pages: null,
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
