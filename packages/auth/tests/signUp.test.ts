import type { User } from '../src/auth'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'

function setup(options: Parameters<typeof testApp>[0] = {}) {
  const signUps: User[] = []
  const app = testApp({
    onSignUp: ({ user }) => {
      signUps.push(user)
    },
    ...options,
  })

  return { ...app, signUps }
}

describe('signUp: false', () => {
  test('refuses registering and guests, keeping no user, and the features say so', async () => {
    const { browser, signUps, store } = setup({ signUp: false })
    const visitor = browser()

    expect(await visitor.post('/register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'closed' })
    expect(await visitor.call('signInAsGuest')).toEqual({ ok: false, error: 'closed' })
    expect(await visitor.call('features')).toMatchObject({ signUp: false })
    expect((await store.users.list({ offset: 0, limit: 10 })).total).toBe(0)
    expect(signUps).toEqual([])
  })

  test('a user the app made signs in with their password', async () => {
    const { auth, browser } = setup({ signUp: false })
    const created = await auth.admin.createUser({ email: 'ada@example.com', password: PASSWORD })
    const ada = browser()

    expect(created.ok).toBe(true)
    expect(await ada.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, redirect: '/' })
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
  })

  test('is open by default', async () => {
    const { browser } = setup()

    expect(await browser().call('features')).toMatchObject({ signUp: true })
  })
})

describe('createUser', () => {
  test('makes a user with the default roles and the given ones, signing no one in', async () => {
    const { auth, signUps } = setup({ defaultRoles: ['editor'] })
    const result = await auth.admin.createUser({ email: 'Ada@Example.com', username: 'ada', password: PASSWORD, roles: ['admin', 'editor'], emailVerified: true, locale: 'fr' })

    expect(result).toMatchObject({ ok: true, user: { email: 'ada@example.com', username: 'ada', emailVerified: true, hasPassword: true, roles: ['editor', 'admin'], locale: 'fr', guest: false } })
    expect(signUps).toHaveLength(1)
    expect(await auth.sessionCookie(result.ok ? result.user.id : '')).toContain('=')
  })

  test('a user without a password or a verified address, by username alone', async () => {
    const { auth } = setup()

    expect(await auth.admin.createUser({ username: 'grace' })).toMatchObject({ ok: true, user: { email: null, username: 'grace', emailVerified: false, hasPassword: false, roles: [] } })
  })

  test('refuses what registering refuses, field by field', async () => {
    const { auth } = setup()

    await auth.admin.createUser({ email: 'ada@example.com', username: 'ada' })

    expect(await auth.admin.createUser({ email: 'ada@example.com', username: 'ADA', password: 'short' })).toEqual({ ok: false, errors: { email: 'taken', username: 'taken', password: 'too-short' } })
    expect(await auth.admin.createUser({ email: 'not-an-address' })).toMatchObject({ ok: false, errors: { email: expect.any(String) } })
  })

  test('throws without an email or a username to sign in with', async () => {
    const { auth } = setup()

    await expect(auth.admin.createUser({ password: PASSWORD })).rejects.toThrow('needs an email or a username')
  })

  test('throws on a role the `roles` option does not declare, as one read from a script\'s arguments may be', async () => {
    const { auth, store } = setup()

    await expect(auth.admin.createUser({ username: 'ada', roles: ['ghost' as 'admin'] })).rejects.toThrow('\'ghost\', which the `roles` option does not declare')
    expect((await store.users.list({ offset: 0, limit: 10 })).total).toBe(0)
  })
})

describe('open password sign-up without a mailer', () => {
  const real = process.env.NODE_ENV ?? 'test'

  afterEach(() => {
    process.env.NODE_ENV = real
  })

  function warnings(env: string, options: Parameters<typeof testApp>[0]): string {
    process.env.NODE_ENV = env
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      testApp({ breachedPasswords: false, ...options })

      return warned.mock.calls.flat().join(' ')
    }
    finally {
      warned.mockRestore()
    }
  }

  test('answers taken for a held address, so a guest learns it, and production warns at boot', async () => {
    const { browser } = setup()

    await browser().post('/register', { email: 'ada@example.com', password: PASSWORD })

    expect(await browser().post('/register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, errors: { email: 'taken' } })
    expect(warnings('production', {})).toContain('answers `taken` for an address that has an account')
  })

  test.each([
    ['in development', 'development', {}],
    ['with signUp closed', 'production', { signUp: false }],
    ['with passwords off', 'production', { password: false }],
    ['with a mailer', 'production', { site: 'https://site.test', email: { mailer: () => undefined, links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' } } }],
  ] as const)('stays quiet %s', (_name, env, options) => {
    expect(warnings(env, options as never)).not.toContain('answers `taken`')
  })
})
