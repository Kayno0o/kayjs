import type { AnyElysia } from 'elysia'
import type { AuthMailMessage as Mail } from '../src/mail'
import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { Elysia } from 'elysia'
import { session } from 'kay/server'
import { createAuth } from '../src/auth'
import { log } from '../src/log'
import { memoryAuthStore } from '../src/memoryStore'
import { discordProvider, githubProvider } from '../src/oauth/providers'
import { auth, authExtension, authPages } from '../src/pages'
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

describe('authPages and createAuth share the prefix and home', () => {
  const SECRET = 'a-test-secret-that-is-long-enough-for-kayjs-auth'

  // What `features().pages` says of an auth module that `authPages` loads, where `make` is the module's `createAuth` call.
  async function loaded(extension: { prefix?: string, home?: string }, make: (pages: Record<string, unknown> | boolean | undefined) => ReturnType<typeof createAuth>, pages: Record<string, unknown> | boolean | undefined) {
    const pagesExtension = authPages({ ...extension, auth: async () => ({ auth: make(pages) }) })
    const plugin = await (pagesExtension.server as () => Promise<AnyElysia>)()
    const app = new Elysia().use(plugin).get('/features', context => (context as unknown as { auth: { features: () => unknown } }).auth.features())

    return (await (await app.handle(new Request('http://localhost/features'))).json() as { pages: unknown }).pages
  }

  const make = (pages: Record<string, unknown> | boolean | undefined) => createAuth({ sessions: session({ secret: SECRET }), secret: SECRET, store: memoryAuthStore(), proxy: { hops: 1 }, captcha: false, ...pages === undefined ? {} : { pages } })

  test('the prefix and home given to authPages alone reach createAuth, which asks for the pages with `pages: true`', async () => {
    expect(await loaded({ prefix: '/account', home: '/dashboard' }, make, true)).toMatchObject({ prefix: '/account', home: '/dashboard' })
    expect(await loaded({}, make, true)).toMatchObject({ prefix: '/auth', home: '/' })
  })

  test('createAuth keeps its own home, and the same prefix given in both places is the one prefix', async () => {
    expect(await loaded({ prefix: '/account' }, make, { home: '/dashboard' })).toMatchObject({ prefix: '/account', home: '/dashboard' })
    expect(await loaded({ prefix: '/account' }, make, { prefix: '/account' })).toMatchObject({ prefix: '/account' })
  })

  test('a home given differently to createAuth and authPages logs a warning naming both and createAuth keeps its own, a home given alike or once logs none', async () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => undefined)

    try {
      expect(await loaded({ prefix: '/account', home: '/dashboard' }, make, { prefix: '/account', home: '/panel' })).toMatchObject({ prefix: '/account', home: '/panel' })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('auth({ home: \'/dashboard\' }) and createAuth({ pages: { home: \'/panel\' } }) differ')

      await loaded({ home: '/panel' }, make, { home: '/panel' })
      await loaded({}, make, { home: '/panel' })
      await loaded({ prefix: '/account', home: '/dashboard' }, make, { prefix: '/account' })
      await loaded({ home: '/dashboard' }, make, true)
      expect(warn).toHaveBeenCalledTimes(1)
    }
    finally {
      warn.mockRestore()
    }
  })

  test('a prefix in createAuth that authPages does not serve stops the server, also when authPages gave none', async () => {
    await expect(loaded({ prefix: '/account' }, make, { prefix: '/profile' })).rejects.toThrow('auth() serves the pages under \'/account\' and createAuth({ pages: { prefix: \'/profile\' } })')
    await expect(loaded({}, make, { prefix: '/account' })).rejects.toThrow('Give auth({ prefix: \'/account\' })')
  })

  test('an auth module made before authPages loaded it follows it or is checked against it, and createAuth without pages is left alone', async () => {
    const before = make({ prefix: '/profile' })
    const defaults = make(true)
    const plain = make(undefined)

    await expect((authPages({ prefix: '/account', auth: async () => ({ auth: before }) }).server as () => Promise<AnyElysia>)()).rejects.toThrow('sends users to \'/profile\'')
    await expect((authPages({ prefix: '/account', auth: async () => ({ auth: defaults }) }).server as () => Promise<AnyElysia>)()).resolves.toBeDefined()
    await expect((authPages({ prefix: '/account', auth: async () => ({ auth: plain }) }).server as () => Promise<AnyElysia>)()).resolves.toBeDefined()
    await expect((authPages({ auth: async () => ({ auth: defaults }) }).server as () => Promise<AnyElysia>)()).resolves.toBeDefined()
  })

  test('authExtension, which serves no pages, leaves a prefix of createAuth alone', async () => {
    const plugin = await (authExtension(async () => ({ auth: make({ prefix: '/profile' }) })).server as () => Promise<AnyElysia>)()

    expect(plugin).toBeDefined()
  })

  test('createAuth outside authPages takes the prefix it is given, and nothing leaks from a load that failed', async () => {
    await expect(loaded({ prefix: '/account' }, make, { prefix: '/profile' })).rejects.toThrow()
    await expect(loaded({}, () => {
      throw new Error('store down')
    }, true)).rejects.toThrow('store down')

    const { browser } = testApp({ pages: true })

    expect(await browser().call('features')).toMatchObject({ pages: { prefix: '/auth', home: '/' } })
  })
})

describe('auth({ module }) registers the app\'s auth module', () => {
  const SECRET = 'a-test-secret-that-is-long-enough-for-kayjs-auth'
  const make = (pages?: Record<string, unknown> | boolean) => createAuth({ sessions: session({ secret: SECRET }), secret: SECRET, store: memoryAuthStore(), proxy: { hops: 1 }, captcha: false, ...pages === undefined ? {} : { pages } })

  // What `features().pages` says once `prepare` handed the module's `auth` the extension's prefix and home, as kay does before it takes the plugin.
  async function adopted(options: Parameters<typeof auth>[0], pages: Record<string, unknown> | boolean | undefined) {
    const exported = make(pages)

    await auth({ module: './src/auth', ...options }).serverModule!.prepare!(exported)

    const app = new Elysia().use(exported.plugin).get('/features', context => (context as unknown as { auth: { features: () => unknown } }).auth.features())

    return (await (await app.handle(new Request('http://localhost/features'))).json() as { pages: unknown }).pages
  }

  test('names the module and the export kay takes the plugin from, with the pages, the dev tool and the command', () => {
    const extension = auth({ module: './src/auth' })

    expect(extension).toMatchObject({ name: '@kaynooo/kayjs-auth', serverModule: { path: './src/auth', export: 'auth' }, prefix: '/auth', home: '/', routes: { prefix: '/auth' } })
    expect(extension.messages).toBeDefined()
    expect(extension.devTool).toEqual(authPages().devTool)
    expect(extension.commands).toEqual(authPages().commands)
  })

  test('pages: false serves the plugin alone', () => {
    const extension = auth({ module: './src/auth', pages: false })

    expect(extension.routes).toBeUndefined()
    expect(extension.messages).toBeUndefined()
    expect(extension.serverModule?.export).toBe('auth')
  })

  test('hands createAuth the prefix and home, as authPages did', async () => {
    expect(await adopted({ prefix: '/account', home: '/dashboard' }, true)).toMatchObject({ prefix: '/account', home: '/dashboard' })
    expect(await adopted({}, true)).toMatchObject({ prefix: '/auth', home: '/' })
    expect(await adopted({ prefix: '/account' }, { home: '/dashboard' })).toMatchObject({ prefix: '/account', home: '/dashboard' })
    await expect(adopted({ prefix: '/account' }, { prefix: '/profile' })).rejects.toThrow('auth() serves the pages under \'/account\'')
  })

  test('a module exporting no auth is told how to export it', () => {
    expect(async () => auth({ module: './src/auth' }).serverModule!.prepare!(undefined)).toThrow('./src/auth exports no `auth`')
    expect(auth({ module: './src/auth', pages: false }).serverModule!.prepare!(undefined)).toBeUndefined()
  })

  test('takes a module or a server, not both', () => {
    expect(() => auth({ module: './src/auth', server: () => new Elysia() })).toThrow('takes `module` or `server`')
    expect(auth({ server: () => new Elysia() }).serverModule).toBeUndefined()
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
    const { browser, store } = testApp({ audit: true, exportData: ({ user }) => ({ posts: [`by ${user.email}`] }) })
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
    const { browser } = testApp({ rateLimit: { export: { max: 2, window: '3600s' } } })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect((await ada.call('exportData')).ok).toBe(true)
    expect((await ada.fetch('/auth/export')).status).toBe(200)
    expect(await ada.call('exportData')).toEqual({ ok: false, error: 'limited' })
    expect((await ada.fetch('/auth/export')).status).toBe(429)
  })

  describe('needs a sign-in or a proof under ten minutes old, so a stolen session downloads nothing', () => {
    test('a stale session is refused by the method and the route, neither counting against the limit', async () => {
      const { browser } = testApp({ rateLimit: { export: { max: 1, window: '3600s' } } })
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
