import type { User } from '../src/auth'
import { describe, expect, test } from 'bun:test'
import { testApp, userRecord } from './helpers/app'

const PASSWORD = 'correct horse battery'

function setup(options: Parameters<typeof testApp>[0] = {}) {
  const signUps: User[] = []
  const app = testApp({
    onSignUp: (user) => {
      signUps.push(user)
    },
    ...options,
  })

  return { ...app, signUps }
}

describe('guests', () => {
  test('a guest is a user with no way back in, signed in on this browser, and asking again answers the same one', async () => {
    const { browser, signUps } = setup()
    const guest = browser()
    const first = await guest.callOk('signInAsGuest')

    expect(first).toMatchObject({ ok: true, user: { guest: true, email: null, hasPassword: false } })
    expect(await guest.json('/me')).toMatchObject({ id: first.user.id, guest: true })
    expect((await guest.callOk('signInAsGuest')).user.id).toBe(first.user.id)
    expect(signUps).toHaveLength(1)
  })

  test('a user signed in already is no guest', async () => {
    const { browser } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('signInAsGuest')).toEqual({ ok: false, error: 'signed-in' })
  })

  test('registering makes the guest a real account, keeping their id, even where addresses must be verified', async () => {
    const { browser, signUps, store } = setup({ email: { mailer: { send: () => undefined }, links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }, requireVerified: true }, url: 'https://site.test' })
    const guest = browser()
    const { user } = await guest.callOk('signInAsGuest')

    expect(await guest.call('register', { email: 'ada@example.com', password: PASSWORD, username: 'ada' })).toMatchObject({ ok: true, user: { id: user.id, guest: false, email: 'ada@example.com' }, signedIn: true })
    expect(await guest.json('/me')).toMatchObject({ id: user.id, guest: false, hasPassword: true })
    expect((await store.users.list({ offset: 0, limit: 10 })).total).toBe(1)
    expect(signUps).toHaveLength(1)
  })

  test('where addresses must be verified, a guest registering a held address stays a guest', async () => {
    const { browser, store } = setup({ email: { mailer: { send: () => undefined }, links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' } }, url: 'https://site.test' })

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))
    const guest = browser()
    const { user } = await guest.callOk('signInAsGuest')

    expect(await guest.call('register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect(await guest.json('/me')).toMatchObject({ id: user.id, guest: true, email: null })
  })

  test('a register refused leaves the guest as they were', async () => {
    const { browser } = setup()

    await browser().call('register', { email: 'ada@example.com', password: PASSWORD })

    const guest = browser()
    const { user } = await guest.callOk('signInAsGuest')

    expect(await guest.call('register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, errors: { email: 'taken' } })
    expect(await guest.json('/me')).toMatchObject({ id: user.id, guest: true, email: null })
  })

  test('guests are counted as registering', async () => {
    const { browser } = setup({ rateLimit: { register: { max: 1, window: 3600 } } })

    expect(await browser().call('signInAsGuest')).toMatchObject({ ok: true })
    expect(await browser().call('signInAsGuest')).toEqual({ ok: false, error: 'limited' })
  })
})
