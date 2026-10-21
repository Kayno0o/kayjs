import type { ForwardAuthOptions, ForwardDomains } from '../src/forwardAuth'
import { describe, expect, test } from 'bun:test'
import { forwardOf, returnTarget } from '../src/forwardAuth'
import { totpCode, totpStep } from '../src/totp'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const PORTAL = 'https://auth.example.test'
const GUARDED = 'https://wiki.example.test/page?x=1'

function setup(forwardAuth: ForwardDomains | ForwardAuthOptions = 'example.test') {
  const app = testApp({ url: PORTAL, pages: true, forwardAuth })

  // A person signed in on their own browser.
  async function signedIn(fields: { username?: string, email?: string, roles?: ('admin' | 'editor')[] }, twoFactor = false) {
    const made = await app.auth.createUser({ password: PASSWORD, emailVerified: true, ...fields })

    if (!made.ok)
      throw new Error(JSON.stringify(made.errors))

    const browser = app.browser()

    await browser.post(`/sign-in/${made.user.id}`, {})

    if (twoFactor) {
      const set = await browser.callOk('setUpTwoFactor', { password: PASSWORD })

      await browser.callOk('enableTwoFactor', await totpCode(set.setup.secret, totpStep()))
    }

    return { browser, user: made.user }
  }

  const ask = async (browser: ReturnType<typeof app.browser>, path = '/auth/forward', headers: Record<string, string> = { 'x-original-url': GUARDED }) => browser.fetch(path, { headers })

  return { ...app, signedIn, ask }
}

function locationOf(response: Response): URL {
  return new URL(response.headers.get('location')!)
}

describe('a proxy asking whether to let a request through', () => {
  test('a signed-in person gets 204 with who they are, in the headers the proxy hands the site', async () => {
    const { signedIn, ask } = setup()
    const { browser } = await signedIn({ username: 'ada', email: 'ada@example.com', roles: ['admin', 'editor'] })
    const response = await ask(browser)

    expect(response.status).toBe(204)
    expect(Object.fromEntries(response.headers)).toMatchObject({ 'remote-user': 'ada', 'remote-name': 'ada', 'remote-email': 'ada@example.com', 'remote-groups': 'admin,editor', 'cache-control': 'no-store' })
  })

  test('a user with no name is known by email, a name with an accent is percent-encoded and a lone user by id', async () => {
    const { signedIn, ask } = setup()
    const accent = await ask((await signedIn({ username: 'zoé' })).browser)

    expect(accent.headers.get('remote-user')).toBe('zo%C3%A9')
    expect(accent.headers.get('remote-email')).toBe('')
    expect((await ask((await signedIn({ email: 'only@example.com' })).browser)).headers.get('remote-user')).toBe('only@example.com')
  })

  test('an anonymous visitor gets 401 with the sign-in page, coming back through the portal to the URL asked for', async () => {
    const { browser, ask } = setup()
    const response = await ask(browser())
    const to = locationOf(response)

    expect(response.status).toBe(401)
    expect(to.origin + to.pathname).toBe(`${PORTAL}/auth/sign-in`)
    expect(to.searchParams.get('redirect')).toBe(`/auth/forward/return?to=${encodeURIComponent(new URL(GUARDED).href)}`)
  })

  test('?redirect makes it a 302 for a proxy that hands the answer to the browser', async () => {
    const { browser, ask } = setup()
    const response = await ask(browser(), '/auth/forward?redirect=1')

    expect(response.status).toBe(302)
    expect(locationOf(response).pathname).toBe('/auth/sign-in')
  })

  test('Traefik and Caddy name the URL in X-Forwarded-*', async () => {
    const { browser, ask } = setup()
    const response = await ask(browser(), '/auth/forward', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'wiki.example.test', 'x-forwarded-uri': '/deep/page?y=2' })

    expect(locationOf(response).searchParams.get('redirect')).toContain(encodeURIComponent('https://wiki.example.test/deep/page?y=2'))
  })

  test('a guest is not a person: 401 although the session is signed in', async () => {
    const { browser, ask } = setup()
    const guest = browser()

    await guest.callOk('signInAsGuest')
    expect((await guest.json('/me') as { guest: boolean }).guest).toBe(true)
    expect((await ask(guest)).status).toBe(401)
  })

  test('a bearer token opens no site, even a valid one', async () => {
    const { auth, signedIn, browser, ask } = setup()
    const { user } = await signedIn({ username: 'ada' })
    const issued = await auth.issueToken(user.id, 'device')

    if (!issued.ok)
      throw new Error('no token')

    const response = await ask(browser(), '/auth/forward', { 'x-original-url': GUARDED, 'authorization': `Bearer ${issued.token}` })

    expect(response.status).toBe(401)
    expect(response.headers.get('remote-user')).toBeNull()
  })

  test('a password sign-in stopped at the second factor opens nothing until the code is given', async () => {
    const { signedIn, browser, ask } = setup()

    await signedIn({ username: 'ada' }, true)

    const pending = browser()
    const answer = await pending.post('/password', { identifier: 'ada', password: PASSWORD }) as { ok: boolean, redirect?: string }

    expect(answer.redirect).toContain('two-factor')
    expect((await ask(pending)).status).toBe(401)
  })

  test('a forged request header changes nothing: Remote-* and Authorization-less claims are ignored', async () => {
    const { browser, ask } = setup()
    const response = await ask(browser(), '/auth/forward', { 'x-original-url': GUARDED, 'remote-user': 'admin', 'remote-groups': 'admin', 'x-forwarded-user': 'admin' })

    expect(response.status).toBe(401)
    expect(response.headers.get('remote-user')).toBeNull()
  })

  test('?role asks for a role: 204 when held, directly or through another, 403 otherwise, any of several', async () => {
    const { signedIn, ask } = setup()
    const admin = (await signedIn({ username: 'boss', roles: ['admin'] })).browser
    const editor = (await signedIn({ username: 'writer', roles: ['editor'] })).browser

    expect((await ask(admin, '/auth/forward?role=admin')).status).toBe(204)
    expect((await ask(admin, '/auth/forward?role=editor')).status).toBe(204)
    expect((await ask(editor, '/auth/forward?role=admin')).status).toBe(403)
    expect((await ask(editor, '/auth/forward?role=admin&role=editor')).status).toBe(204)
    expect((await ask(editor, '/auth/forward?role=nobody')).status).toBe(403)
  })

  test('requireTwoFactor sends a user without it to set it up, keeps one with it, and still needs a session first', async () => {
    const { signedIn, browser, ask } = setup({ domains: 'example.test', requireTwoFactor: true })
    const without = await ask((await signedIn({ username: 'plain' })).browser)

    expect(without.status).toBe(401)
    expect(locationOf(without).href).toBe(`${PORTAL}/auth/account/security`)

    const secured = await signedIn({ username: 'secure' }, true)

    expect((await ask(secured.browser)).status).toBe(204)
    expect(locationOf(await ask(browser())).pathname).toBe('/auth/sign-in')
  })

  test('a hostile original URL is dropped from the sign-in return, the visitor still being sent to sign in', async () => {
    const { browser, ask } = setup()

    for (const original of ['https://evil.test/', 'https://example.test.evil.test/', 'https://evilexample.test/', 'http://wiki.example.test/', '//evil.test', 'javascript:alert(1)', 'https://wiki.example.test@evil.test/', 'https://user:pw@wiki.example.test/', `https://wiki.example.test/${'a'.repeat(3000)}`]) {
      const response = await ask(browser(), '/auth/forward', { 'x-original-url': original })

      expect(response.status).toBe(401)
      expect(locationOf(response).search).toBe('')
      expect(locationOf(response).pathname).toBe('/auth/sign-in')
    }
  })

  test('a header that is not a legal URL, a missing one, and a broken forwarded host all end at the plain sign-in', async () => {
    const { browser, ask } = setup()

    for (const headers of [{}, { 'x-original-url': 'not a url' }, { 'x-forwarded-host': 'a,b', 'x-forwarded-proto': 'https' }, { 'x-forwarded-host': 'wiki.example.test', 'x-forwarded-proto': 'ftp' }])
      expect(locationOf(await ask(browser(), '/auth/forward', headers)).search).toBe('')
  })
})

describe('coming back from signing in', () => {
  test('goes to the guarded site on the allowed domains, and home for anything else', async () => {
    const { browser } = setup()
    const back = async (to: string) => browser().fetch(`/auth/forward/return?to=${encodeURIComponent(to)}`)

    expect((await back(GUARDED)).headers.get('location')).toBe(new URL(GUARDED).href)
    expect((await back('https://example.test/')).headers.get('location')).toBe('https://example.test/')

    for (const to of ['https://evil.test/', 'https://example.test.evil.test/', 'https://notexample.test/', '//evil.test/', 'javascript:alert(1)', 'http://wiki.example.test/', 'https://a@evil.test/', '/auth/account', ''])
      expect((await back(to)).headers.get('location')).toBe('/')

    expect((await browser().fetch('/auth/forward/return')).headers.get('location')).toBe('/')
  })

  test('the home is the pages\' home', async () => {
    const app = testApp({ url: PORTAL, pages: { home: '/dashboard' }, forwardAuth: 'example.test' })

    expect((await app.browser().fetch('/auth/forward/return?to=https://evil.test/')).headers.get('location')).toBe('/dashboard')
  })
})

describe('the domains', () => {
  test('match the domain and its subdomains only, through the browser\'s own reading of the URL', () => {
    const domains = ['example.test']

    expect(returnTarget('https://example.test', domains)).toBe('https://example.test/')
    expect(returnTarget('HTTPS://WIKI.Example.TEST/a b', domains)).toBe('https://wiki.example.test/a%20b')
    expect(returnTarget('https://wiki.example.test.', domains)).toBeUndefined()
    expect(returnTarget('https://wiki.example.test\t.evil.test/', domains)).toBeUndefined()
    expect(returnTarget('https://example.test\\.evil.test/', domains)).toBe('https://example.test/.evil.test/')
    expect(returnTarget('https://wiki.example.test\\@evil.test/', domains)).toBe('https://wiki.example.test/@evil.test/')
    expect(returnTarget('https://ex%61mple.test.evil.test/', domains)).toBeUndefined()
    expect(returnTarget(null, domains)).toBeUndefined()
  })

  test('are checked when the app starts: a bare suffix, a scheme, a path or a port stops it', () => {
    expect(forwardOf(undefined)).toBeUndefined()
    expect(forwardOf(' Example.Test ')).toEqual({ domains: ['example.test'], requireTwoFactor: false })
    expect(forwardOf(['a.test', 'b.test'])?.domains).toEqual(['a.test', 'b.test'])

    for (const bad of ['com', 'https://example.test', 'example.test/path', 'example.test:8443', '.example.test', 'example.test.', 'a..test', '', 'a b.test'])
      expect(() => forwardOf(bad)).toThrow('forwardAuth')

    expect(() => forwardOf([])).toThrow('at least one domain')
  })

  test('are not served without the option', async () => {
    const app = testApp({ url: PORTAL })

    expect((await app.browser().fetch('/auth/forward')).status).toBe(404)
  })
})
