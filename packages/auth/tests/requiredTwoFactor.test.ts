import type { GuardContext } from 'kay'
import { describe, expect, spyOn, test } from 'bun:test'
import { Elysia } from 'elysia'
import { session } from 'kay/server'
import { createAuth } from '../src/auth'
import { log } from '../src/log'
import { memoryAuthStore } from '../src/memoryStore'
import { totpCode, totpStep } from '../src/totp'
import { SECRET, testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const HTML = { accept: 'text/html' }

function setup(options: Parameters<typeof testApp>[0] = {}) {
  const app = testApp({ site: 'https://app.example.test', pages: true, admin: 'admin', twoFactor: { require: ['admin'] }, ...options })

  // A guard's verdict on the route asked, `x-options` its options as JSON: what it passed, redirected to or denied with.
  app.app.get('/guarded', async ({ auth, request }) => {
    const url = new URL(request.url)
    const context = {
      request,
      url,
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
      await auth.guarded(context, JSON.parse(request.headers.get('x-options') ?? '{}'))

      return 'passed'
    }
    catch (outcome) {
      return (outcome as Error).message
    }
  })
  app.app.use(new Elysia().use(app.auth.gate()).get('/gated', () => 'in').get('/gated-editor', () => 'in', { auth: 'editor' }))

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

  const guarded = async (who: Awaited<ReturnType<typeof member>>, options: object = {}, headers: Record<string, string> = HTML) => (await who.browser.fetch('/guarded', { headers: { ...headers, 'x-options': JSON.stringify(options) } })).text()

  return { ...app, member, guarded }
}

describe('twoFactor.require', () => {
  test('a guard sends a user lacking it to the security page when opening a page, and denies any other request', async () => {
    const { member, guarded } = setup()
    const admin = await member(['admin'])

    expect(await guarded(admin)).toBe('redirect /auth/account/security?redirect=%2Fguarded')
    expect(await guarded(admin, {}, { accept: 'application/json' })).toBe('deny 403')
    expect(await guarded(admin, { require: 'admin' })).toBe('redirect /auth/account/security?redirect=%2Fguarded')
  })

  test('a user mid-enrolment still lacks it, one who finished passes', async () => {
    const { member, guarded } = setup()
    const pending = await member(['admin'], 'pending')
    const done = await member(['admin'], 'done')

    expect(await guarded(pending)).toContain('redirect /auth/account/security')
    expect(await guarded(done)).toBe('passed')
  })

  test('a user the requirement does not name is not asked', async () => {
    const { member, guarded } = setup()

    expect(await guarded(await member(['editor']))).toBe('passed')
    expect(await guarded(await member([]))).toBe('passed')
  })

  test('the guard decides for itself: true asks everyone, false no one', async () => {
    const { member, guarded } = setup()
    const editor = await member(['editor'])
    const admin = await member(['admin'])

    expect(await guarded(editor, { twoFactor: true })).toContain('redirect /auth/account/security')
    expect(await guarded(admin, { twoFactor: false })).toBe('passed')
  })

  test('a predicate names who is asked, an organization role included', async () => {
    const { member, guarded } = setup({ twoFactor: { require: user => user !== null && user.email?.startsWith('editor') === true } })

    expect(await guarded(await member(['editor']))).toContain('redirect')
    expect(await guarded(await member(['admin']))).toBe('passed')
  })

  test('a gate denies it with a 403, a bearer token as the user it holds', async () => {
    const { auth, member, browser } = setup()
    const admin = await member(['admin'])
    const done = await member(['admin'], 'done')

    expect((await admin.browser.fetch('/gated')).status).toBe(403)
    expect((await done.browser.fetch('/gated')).status).toBe(200)
    expect((await admin.browser.fetch('/gated-editor')).status).toBe(403)

    const issued = await auth.issueToken(admin.id, 'device')

    if (!issued.ok)
      throw new Error('no token')

    expect((await browser().fetch('/gated', { headers: { authorization: `Bearer ${issued.token}` } })).status).toBe(403)
  })

  test('a user signed in by a passkey alone lacks it, as the passkey is no authenticator app', async () => {
    const { member, guarded, store } = setup()
    const admin = await member(['admin'])
    const record = await store.users.get(admin.id)

    expect(record?.totpEnabledAt).toBeNull()
    expect(await guarded(admin)).toContain('redirect')
  })

  test('admin methods answer two-factor-required, every one of them', async () => {
    const { member } = setup()
    const admin = await member(['admin'])
    const other = await member([])

    for (const [method, args] of [['listUsers', []], ['getUser', [other.id]], ['grantRole', [other.id, 'editor']], ['revokeRole', [other.id, 'editor']], ['ban', [other.id]], ['unban', [other.id]], ['deleteUser', [other.id]], ['impersonate', [other.id]], ['auditLog', []]] as const)
      expect(await (admin.browser.call as (path: string, ...args: unknown[]) => Promise<unknown>)(`admin.${method}`, ...args)).toEqual({ ok: false, error: 'two-factor-required' })
  })

  test('admin methods work once it is on', async () => {
    const { member } = setup()
    const admin = await member(['admin'], 'done')

    expect((await admin.browser.call('admin.listUsers') as { ok: boolean }).ok).toBe(true)
  })

  test('requireAdmin sends a page opening to the security page', async () => {
    const { app, member } = setup()

    app.get('/admin-page', async ({ auth }) => {
      try {
        await auth.requireAdmin()
      }
      catch (outcome) {
        return (outcome as { location?: string }).location ?? 'denied'
      }

      return 'admin'
    })

    const admin = await member(['admin'])
    const response = await admin.browser.fetch('/admin-page', { headers: HTML })

    expect(await response.text()).toBe('/auth/account/security?redirect=%2Fadmin-page')
  })

  test('without it every guard, gate and admin stays as it was', async () => {
    const { member, guarded } = setup({ twoFactor: undefined })
    const admin = await member(['admin'])

    expect(await guarded(admin)).toBe('passed')
    expect((await admin.browser.call('admin.listUsers') as { ok: boolean }).ok).toBe(true)
  })

  test('twoFactor: false switches the requirement off with the feature', async () => {
    const { member, guarded } = setup({ twoFactor: false })

    expect(await guarded(await member(['admin']))).toBe('passed')
  })
})

describe('the boot warning', () => {
  const make = (twoFactor?: boolean | { require: 'admin'[] }) => createAuth({ sessions: session({ secret: SECRET }), secret: SECRET, store: memoryAuthStore(), roles: { admin: [] }, admin: 'admin', ...twoFactor === undefined ? {} : { twoFactor } })

  test('warns in production when admin is on and no requirement names it', () => {
    const was = process.env.NODE_ENV
    const warned = spyOn(log, 'warn').mockImplementation(() => undefined)

    process.env.NODE_ENV = 'production'

    try {
      const told = () => warned.mock.calls.filter(([message]) => String(message).includes('twoFactor.require')).length

      make()
      expect(told()).toBe(1)

      make({ require: ['admin'] })
      make(false)
      expect(told()).toBe(1)
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
    expect(warned.mock.calls.filter(([message]) => String(message).includes('twoFactor.require'))).toEqual([])
    warned.mockRestore()
  })
})
