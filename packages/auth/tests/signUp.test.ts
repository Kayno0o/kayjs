import type { User } from '../src/auth'
import { describe, expect, test } from 'bun:test'
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
    const created = await auth.createUser({ email: 'ada@example.com', password: PASSWORD })
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
    const result = await auth.createUser({ email: 'Ada@Example.com', username: 'ada', password: PASSWORD, roles: ['admin', 'editor'], emailVerified: true, locale: 'fr' })

    expect(result).toMatchObject({ ok: true, user: { email: 'ada@example.com', username: 'ada', emailVerified: true, hasPassword: true, roles: ['editor', 'admin'], locale: 'fr', guest: false } })
    expect(signUps).toHaveLength(1)
    expect(await auth.sessionCookie(result.ok ? result.user.id : '')).toContain('=')
  })

  test('a user without a password or a verified address, by username alone', async () => {
    const { auth } = setup()

    expect(await auth.createUser({ username: 'grace' })).toMatchObject({ ok: true, user: { email: null, username: 'grace', emailVerified: false, hasPassword: false, roles: [] } })
  })

  test('refuses what registering refuses, field by field', async () => {
    const { auth } = setup()

    await auth.createUser({ email: 'ada@example.com', username: 'ada' })

    expect(await auth.createUser({ email: 'ada@example.com', username: 'ADA', password: 'short' })).toEqual({ ok: false, errors: { email: 'taken', username: 'taken', password: 'too-short' } })
    expect(await auth.createUser({ email: 'not-an-address' })).toMatchObject({ ok: false, errors: { email: expect.any(String) } })
  })

  test('throws without an email or a username to sign in with', async () => {
    const { auth } = setup()

    await expect(auth.createUser({ password: PASSWORD })).rejects.toThrow('needs an email or a username')
  })

  test('throws on a role the `roles` option does not declare, as one read from a script\'s arguments may be', async () => {
    const { auth, store } = setup()

    await expect(auth.createUser({ username: 'ada', roles: ['ghost' as 'admin'] })).rejects.toThrow('\'ghost\', which the `roles` option does not declare')
    expect((await store.users.list({ offset: 0, limit: 10 })).total).toBe(0)
  })
})

describe('hooks in their positional shape, read until 1.73', () => {
  test('onSignUp with two parameters still runs', async () => {
    const seen: string[] = []
    const { auth } = testApp({
      // @ts-expect-error The positional shape is no longer typed.
      onSignUp: (user: User, profile: unknown) => void seen.push(`signUp ${user.email} ${String(profile)}`),
    })
    const created = await auth.createUser({ email: 'ada@example.com', password: PASSWORD })

    expect(created.ok).toBe(true)
    expect(seen).toEqual(['signUp ada@example.com undefined'])
  })
})
