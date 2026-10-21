import type { AuthSessionData } from '../src/auth'
import { afterEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { setSite } from 'kay/library'
import { session } from 'kay/server'
import { createAuth } from '../src/auth'
import { memoryStore } from '../src/memoryStore'
import { discordProvider } from '../src/oauth/providers'
import { SECRET, testApp } from './helpers/app'
import { mailbox } from './helpers/mail'

const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const OAUTH = { discord: { provider: discordProvider(), clientId: 'a', clientSecret: 'b' } }

afterEach(() => {
  setSite(undefined)
})

describe('the site\'s origin kayjs-auth builds URLs on', () => {
  test('is the site of kay.config.ts when createAuth gets no url', async () => {
    setSite('https://app.example.com')

    const response = await testApp({ oauth: OAUTH }).browser().fetch('/auth/discord')

    expect(new URL(response.headers.get('location')!).searchParams.get('redirect_uri')).toBe('https://app.example.com/auth/discord/callback')
  })

  test('follows the mount point of base', async () => {
    setSite('https://app.example.com/docs')

    const response = await testApp({ oauth: OAUTH }).browser().fetch('/auth/discord')

    expect(new URL(response.headers.get('location')!).searchParams.get('redirect_uri')).toBe('https://app.example.com/docs/auth/discord/callback')
  })

  test('is the url given when both are set', async () => {
    setSite('https://app.example.com')

    const response = await testApp({ oauth: OAUTH, url: 'https://given.example.com/' }).browser().fetch('/auth/discord')

    expect(new URL(response.headers.get('location')!).searchParams.get('redirect_uri')).toBe('https://given.example.com/auth/discord/callback')
  })

  test('is found by an auth made before the server set the site up, as an entry file makes it', async () => {
    const app = testApp({ oauth: OAUTH })

    setSite('https://late.example.com')

    const response = await app.browser().fetch('/auth/discord')

    expect(new URL(response.headers.get('location')!).searchParams.get('redirect_uri')).toBe('https://late.example.com/auth/discord/callback')
  })

  test('builds the mailed links and names the site by its host', async () => {
    setSite('https://app.example.com')

    const { mails, mailer } = mailbox()
    const ada = testApp({ email: { mailer, links: LINKS } }).browser()

    await ada.call('register', { email: 'ada@example.com', password: 'correct horse battery' })

    expect(mails[0]).toMatchObject({ site: 'app.example.com' })
    expect(mails[0]!.url).toStartWith('https://app.example.com/verify?token=')
  })

  test('refuses to start a server when OAuth or mail has no origin from anywhere, naming where it goes', () => {
    const auth = createAuth({ sessions: session<AuthSessionData>({ secret: SECRET }), secret: SECRET, store: memoryStore(), oauth: OAUTH })

    expect(() => new Elysia().use(auth.plugin).listen(0)).toThrow('SITE_URL')
  })

  test('is not needed by an auth with neither OAuth nor mail', () => {
    expect(() => testApp()).not.toThrow()
  })

  test('keeps the objects it built with no origin, and builds them again once the site is known', async () => {
    const auth = createAuth({ sessions: session<AuthSessionData>({ secret: SECRET }), secret: SECRET, store: memoryStore() })
    const app = new Elysia().use(auth.plugin).get('/core', ({ auth }) => {
      const state = Object.getOwnPropertySymbols(auth).find(symbol => symbol.description === 'kayjs-auth.state')!
      const { core } = (auth as unknown as Record<symbol, { core: { refreshers: unknown, oauth: unknown, site: string, passkeys: unknown } }>)[state]!

      const [refreshers, oauth] = [core.refreshers, core.oauth]

      return { same: refreshers === core.refreshers && oauth === core.oauth, site: core.site, passkeys: core.passkeys !== undefined }
    })

    expect(await (await app.handle(new Request('http://localhost/core'))).json()).toEqual({ same: true, site: 'kayjs-auth', passkeys: false })

    setSite('https://late.example.com')

    expect(await (await app.handle(new Request('http://localhost/core'))).json()).toEqual({ same: true, site: 'late.example.com', passkeys: true })
  })
})
