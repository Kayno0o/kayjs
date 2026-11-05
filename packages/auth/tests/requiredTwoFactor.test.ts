import type { GuardContext } from 'kay'
import { createHash } from 'node:crypto'
import { describe, expect, spyOn, test } from 'bun:test'
import { Elysia } from 'elysia'
import { session } from 'kay/server'
import { createAuth } from '../src/auth'
import { log } from '../src/log'
import { memoryAuthStore } from '../src/memoryStore'
import { auth as authPages } from '../src/pages'
import { totpCode, totpStep } from '../src/totp'
import { SECRET, testApp } from './helpers/app'
import { authenticator } from './helpers/authenticator'

const PASSWORD = 'correct horse battery'
const HTML = { accept: 'text/html' }
const JSON_ACCEPT = { accept: 'application/json' }
const SECURITY = '/auth/account/security'
const REDIRECT = 'http://127.0.0.1:33418/callback'
const VERIFIER = 'v'.repeat(64)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

interface Member {
  browser: ReturnType<ReturnType<typeof testApp>['browser']>
  id: string
}

function setup(options: Parameters<typeof testApp>[0] = {}) {
  const app = testApp({ site: 'https://app.example.test', pages: true, admin: 'admin', twoFactor: { require: ['admin'] }, ...options })

  // A guard cascade's verdict on the route asked, `x-guards` the options of each guard from the outermost: what it passed, redirected to or denied with.
  const verdict = async ({ auth, request }: { auth: never, request: Request }) => {
    const url = new URL(request.url)
    const context = {
      request,
      url,
      locale: request.headers.get('x-locale') ?? 'en',
      locals: { auth },
      params: {},
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`)
      },
      deny: (status = 403) => {
        throw new Error(`deny ${status}`)
      },
    } as unknown as GuardContext

    try {
      for (const guard of JSON.parse(request.headers.get('x-guards') ?? '[{}]') as object[])
        await (auth as { guarded: (ctx: GuardContext, options: object) => Promise<void> }).guarded(context, guard)

      return 'passed'
    }
    catch (outcome) {
      return (outcome as Error).message
    }
  }

  for (const path of ['/g/page', '/auth/account/security', '/fr/auth/account/security', '/own/security', '/admin/account/security', '/admin/auth/two-factor', '/g/auth/sign-out', '/sec/auth/account/security', '/pt-BR/auth/account/security', '/pt-br/auth/account/security', '/own/2fa', '/auth/sign-out'])
    app.app.get(path, verdict as never).post(path, verdict as never)

  app.app.use(new Elysia().use(app.auth.gate()).get('/gated', () => 'in').get('/gated-editor', () => 'in', { auth: 'editor' }).get('/gated/auth/account/security', () => 'in').get('/auth/two-factor', () => 'in'))
  const adminPage = async ({ auth }: { auth: { requireAdmin: () => Promise<unknown> } }) => {
    try {
      await auth.requireAdmin()
    }
    catch (outcome) {
      const stopped = outcome as { location?: string, status?: number }

      return stopped.location ?? `deny ${stopped.status}`
    }

    return 'admin'
  }

  app.app.get('/admin-page', adminPage as never).post('/admin-page', adminPage as never)

  async function member(roles: ('admin' | 'editor')[], enrolled: 'none' | 'pending' | 'done' = 'none') {
    const made = await app.auth.admin.createUser({ password: PASSWORD, emailVerified: true, email: `${roles.join('-') || 'plain'}-${Math.random().toString(36).slice(2)}@example.com`, roles })

    if (!made.ok)
      throw new Error(JSON.stringify(made.errors))

    const browser = app.browser()

    await browser.post(`/sign-in/${made.user.id}`, {})

    if (enrolled !== 'none') {
      const set = await browser.callOk('twoFactor.setUp', { password: PASSWORD })

      if (enrolled === 'done')
        await browser.callOk('twoFactor.enable', await totpCode(set.setup.secret, totpStep()))
    }

    return { browser, id: made.user.id }
  }

  const guarded = async (who: Member, guards: object[] = [{}], path = '/g/page', headers: Record<string, string> = HTML) => (await who.browser.fetch(path, { headers: { ...headers, 'x-guards': JSON.stringify(guards) } })).text()

  return { ...app, member, guarded }
}

describe('twoFactor.require in guards', () => {
  test('sends a page opening to the security page and back, and denies any other request', async () => {
    const { member, guarded } = setup()
    const admin = await member(['admin'])

    expect(await guarded(admin)).toBe(`redirect ${SECURITY}?redirect=%2Fg%2Fpage`)
    expect(await guarded(admin, [{ require: 'admin' }])).toBe(`redirect ${SECURITY}?redirect=%2Fg%2Fpage`)
    expect(await guarded(admin, [{}], '/g/page', JSON_ACCEPT)).toBe('deny 403')
    expect((await admin.browser.fetch('/g/page', { method: 'POST', headers: { 'x-guards': '[{}]' } })).status).toBe(200)
    expect(await (await admin.browser.fetch('/g/page', { method: 'POST', headers: { 'x-guards': '[{}]' } })).text()).toBe('deny 403')
  })

  test('keeps the query of the page asked for', async () => {
    const { member } = setup()
    const admin = await member(['admin'])
    const answer = await (await admin.browser.fetch('/g/page?tab=2', { headers: { ...HTML, 'x-guards': '[{}]' } })).text()

    expect(answer).toBe(`redirect ${SECURITY}?redirect=%2Fg%2Fpage%3Ftab%3D2`)
  })

  test('a user mid-enrolment still lacks it, one who finished passes', async () => {
    const { member, guarded } = setup()

    expect(await guarded(await member(['admin'], 'pending'))).toContain(`redirect ${SECURITY}`)
    expect(await guarded(await member(['admin'], 'done'))).toBe('passed')
  })

  test('a user the requirement does not name is not asked, a list names any of its entries', async () => {
    const { member, guarded } = setup({ twoFactor: { require: ['editor', 'admin'] } })

    expect(await guarded(await member(['editor']))).toContain('redirect')
    expect(await guarded(await member([]))).toBe('passed')
  })

  test('a guard can ask everyone with twoFactor: true', async () => {
    const { member, guarded } = setup()

    expect(await guarded(await member(['editor']), [{ twoFactor: true }])).toContain(`redirect ${SECURITY}`)
    expect(await guarded(await member(['editor']))).toBe('passed')
  })

  test('the security page and the second-factor page pass whatever guards run, nested ones included', async () => {
    const { member, guarded } = setup()
    const admin = await member(['admin'])

    for (const path of ['/auth/account/security', '/auth/account/security/'])
      expect(await guarded(admin, [{ redirect: '/login' }, { require: 'admin', twoFactor: true }], path)).toBe('passed')

    expect(await guarded(admin, [{ twoFactor: true }], '/fr/auth/account/security', { ...HTML, 'x-locale': 'fr' })).toBe('passed')
    // A route that merely ends like one of those pages, or carries a prefix that is not the served locale, is held back.
    for (const path of ['/admin/account/security', '/admin/auth/two-factor', '/g/auth/sign-out', '/sec/auth/account/security', '/fr/auth/account/security'])
      expect(await guarded(admin, [{ twoFactor: true }], path)).toContain('redirect')

    expect(await guarded(admin, [{}, { require: 'admin' }], '/g/page')).toContain('redirect')
  })

  test('an app with its own security page is sent there, and reaches it', async () => {
    const { member, guarded } = setup({ pages: false, securityPage: '/own/security' })
    const admin = await member(['admin'])

    expect(await guarded(admin)).toBe('redirect /own/security?redirect=%2Fg%2Fpage')
    expect(await guarded(admin, [{ twoFactor: true }], '/own/security')).toBe('passed')
  })

  test('a security page or second-factor page written with a trailing slash is reached with or without it', async () => {
    const { member, guarded } = setup({ pages: false, securityPage: '/own/security/', twoFactorPage: '/own/2fa/' })
    const admin = await member(['admin'])

    expect(await guarded(admin, [{ twoFactor: true }], '/own/security')).toBe('passed')
    expect(await guarded(admin, [{ twoFactor: true }], '/own/2fa')).toBe('passed')
    expect(await guarded(admin)).toContain('redirect')
  })

  test('the sign-out route is reached, and a locale prefix counts as kay matches it, case included', async () => {
    const { member, guarded } = setup()
    const admin = await member(['admin'])

    expect(await guarded(admin, [{ twoFactor: true }], '/auth/sign-out')).toBe('passed')
    expect(await guarded(admin, [{ twoFactor: true }], '/pt-BR/auth/account/security', { ...HTML, 'x-locale': 'pt-BR' })).toBe('passed')
    expect(await guarded(admin, [{ twoFactor: true }], '/pt-br/auth/account/security', { ...HTML, 'x-locale': 'pt-BR' })).toContain('redirect')
  })

  test('an app with no security page gets the 403', async () => {
    const { member, guarded } = setup({ pages: false })

    expect(await guarded(await member(['admin']))).toBe('deny 403')
  })

  test('a predicate names who is asked, a throwing one fails the request closed', async () => {
    const { member, guarded } = setup({ twoFactor: { require: user => user?.email?.startsWith('editor') === true } })

    expect(await guarded(await member(['editor']))).toContain('redirect')
    expect(await guarded(await member(['admin']))).toBe('passed')

    const broken = setup({ twoFactor: { require: () => {
      throw new Error('boom')
    } } })

    expect(await broken.guarded(await broken.member([]))).toBe('boom')
  })

  test('without it every guard stays as it was, and twoFactor: false switches it off', async () => {
    expect(await setup({ twoFactor: undefined }).guarded(await setup({ twoFactor: undefined }).member(['admin']))).toBe('passed')

    const off = setup({ twoFactor: false })

    expect(await off.guarded(await off.member(['admin']))).toBe('passed')
  })

  test('a passkey sign-in counts as two factors, a password session does not', async () => {
    const { auth, app, browser, guarded } = setup({ site: 'https://site.test' })
    const made = await auth.admin.createUser({ password: PASSWORD, emailVerified: true, email: 'pk@example.com', roles: ['admin'] })

    if (!made.ok)
      throw new Error('no user')

    const device = authenticator()
    const owner = browser()

    await owner.post(`/sign-in/${made.user.id}`, {})

    const { options } = await owner.callOk('passkeys.registrationOptions', { password: PASSWORD })

    await owner.callOk('passkeys.register', await device.create(options), 'key')

    const viaPassword = { browser: owner, id: made.user.id }
    const viaPasskey = { browser: browser(), id: made.user.id }

    expect(await guarded(viaPassword)).toContain('redirect')

    const challenge = await viaPasskey.browser.call('passkeys.signInOptions')

    expect(await viaPasskey.browser.call('passkeys.signIn', await device.get(challenge))).toMatchObject({ ok: true })
    expect(await guarded(viaPasskey)).toBe('passed')
    expect(app).toBeDefined()
  })
})

describe('twoFactor.require in gates', () => {
  test('denies with a 403, a bearer token as the user it holds, and never the enrolment pages', async () => {
    const { auth, member, browser } = setup()
    const admin = await member(['admin'])
    const done = await member(['admin'], 'done')

    expect((await admin.browser.fetch('/gated')).status).toBe(403)
    expect((await done.browser.fetch('/gated')).status).toBe(200)
    expect((await admin.browser.fetch('/gated-editor')).status).toBe(403)
    expect((await admin.browser.fetch('/gated/auth/account/security')).status).toBe(403)
    expect((await admin.browser.fetch('/auth/two-factor')).status).toBe(200)

    const issued = await auth.issueToken(admin.id, 'device')

    if (!issued.ok)
      throw new Error('no token')

    expect((await browser().fetch('/gated', { headers: { authorization: `Bearer ${issued.token}` } })).status).toBe(403)
  })
})

describe('twoFactor.require in the admin pages', () => {
  test('every admin method answers two-factor-required', async () => {
    const { member } = setup()
    const admin = await member(['admin'])
    const other = await member([])
    const call = admin.browser.call.bind(admin.browser) as (path: string, ...args: unknown[]) => Promise<unknown>

    for (const [method, args] of [['listUsers', []], ['getUser', [other.id]], ['grantRole', [other.id, 'editor']], ['revokeRole', [other.id, 'editor']], ['ban', [other.id]], ['unban', [other.id]], ['deleteUser', [other.id]], ['impersonate', [other.id]], ['auditLog', []]] as const)
      expect(await call(`admin.${method}`, ...args)).toEqual({ ok: false, error: 'two-factor-required' })
  })

  test('the admin methods work once it is on', async () => {
    const { member } = setup()
    const admin = await member(['admin'], 'done')

    expect((await admin.browser.call('admin.listUsers') as { ok: boolean }).ok).toBe(true)
  })

  test('requireAdmin sends a page opening to the security page, and answers anything else with a 403', async () => {
    const { member } = setup()
    const admin = await member(['admin'])

    expect(await (await admin.browser.fetch('/admin-page', { headers: HTML })).text()).toBe(`${SECURITY}?redirect=%2Fadmin-page`)
    expect(await (await admin.browser.fetch('/admin-page', { headers: JSON_ACCEPT })).text()).toBe('deny 403')
    expect(await (await admin.browser.fetch('/admin-page', { method: 'POST', headers: HTML })).text()).toBe('deny 403')
  })

  test('an admin acting as another user is not asked, the user alone is', async () => {
    const { member, guarded, browser, auth } = setup({ twoFactor: { require: () => true } })
    const admin = await member(['admin'], 'done')
    const target = await auth.admin.createUser({ password: PASSWORD, emailVerified: true, email: 'target@example.com' })

    if (!target.ok)
      throw new Error('no user')

    expect(await admin.browser.call('admin.impersonate', target.user.id)).toEqual({ ok: true })
    expect(await guarded(admin)).toBe('passed')
    expect(await admin.browser.call('admin.stopImpersonating')).toBe(true)

    const alone = browser()

    await alone.post(`/sign-in/${target.user.id}`, {})
    expect(await guarded({ browser: alone, id: target.user.id })).toContain('redirect')
  })
})

describe('twoFactor.require in OAuth consent', () => {
  function server() {
    return testApp({ site: 'http://localhost', pages: authPages({ server: false }), scopes: ['posts:read'], admin: 'admin', twoFactor: { require: ['admin'] }, oauthServer: { fetch: async () => new Response('missing', { status: 404 }) } })
  }

  async function consent(roles: ('admin' | 'editor')[], enrolled: boolean) {
    const app = server()
    const registered = await (await app.browser().fetch('/auth/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Client', redirect_uris: [REDIRECT] }) })).json() as { client_id: string }
    const made = await app.auth.admin.createUser({ password: PASSWORD, emailVerified: true, email: 'oauth@example.com', roles })

    if (!made.ok)
      throw new Error('no user')

    const ada = app.browser()

    await ada.post(`/sign-in/${made.user.id}`, {})

    if (enrolled) {
      const set = await ada.callOk('twoFactor.setUp', { password: PASSWORD })

      await ada.callOk('twoFactor.enable', await totpCode(set.setup.secret, totpStep()))
    }

    const request = { client_id: registered.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', scope: 'posts:read', state: 'abc' }

    return { ada, request }
  }

  test('refuses an admin lacking it with access_denied, at the endpoint and at the decision', async () => {
    const { ada, request } = await consent(['admin'], false)
    const outcome = await ada.post('/call/oauthServer.authorize', [request]) as { kind: string, url: string }

    expect(outcome.kind).toBe('redirect')
    expect(new URL(outcome.url).searchParams.get('error')).toBe('access_denied')

    const decided = await ada.post('/call/oauthServer.decide', [request, true]) as { ok: true, redirect: string }

    expect(new URL(decided.redirect).searchParams.get('error')).toBe('access_denied')
    expect(new URL(decided.redirect).searchParams.get('code')).toBeNull()
  })

  test('lets through one it does not name, or who has it', async () => {
    for (const [roles, enrolled] of [[['editor'], false], [['admin'], true]] as const) {
      const { ada, request } = await consent([...roles], enrolled)
      const decided = await ada.post('/call/oauthServer.decide', [request, true]) as { redirect: string }

      expect(new URL(decided.redirect).searchParams.get('code')).not.toBeNull()
    }
  })
})

describe('the boot warning', () => {
  const make = (twoFactor?: boolean | { require: 'admin'[] }) => createAuth({ sessions: session({ secret: SECRET }), secret: SECRET, store: memoryAuthStore(), roles: { admin: [] }, admin: 'admin', ...twoFactor === undefined ? {} : { twoFactor } })
  const told = (warned: { mock: { calls: unknown[][] } }) => warned.mock.calls.filter(([message]) => String(message).includes('twoFactor.require')).length

  test('warns in production when admin is on and no requirement names it', () => {
    const was = process.env.NODE_ENV
    const warned = spyOn(log, 'warn').mockImplementation(() => undefined)

    process.env.NODE_ENV = 'production'

    try {
      make()
      expect(told(warned)).toBe(1)

      make({ require: ['admin'] })
      make(false)
      expect(told(warned)).toBe(1)
    }
    finally {
      if (was === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = was

      warned.mockRestore()
    }
  })

  test('is quiet outside production', () => {
    const warned = spyOn(log, 'warn').mockImplementation(() => undefined)

    make()
    expect(told(warned)).toBe(0)
    warned.mockRestore()
  })
})
