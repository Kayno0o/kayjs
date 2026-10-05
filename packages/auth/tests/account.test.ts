import type { User } from '../src/auth'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { testApp, userRecord } from './helpers/app'

const PASSWORD = 'correct horse battery'
const POST = { method: 'POST' }

afterEach(() => {
  setSystemTime()
})

async function registered(options: Parameters<typeof testApp>[0] = {}) {
  const app = testApp(options)
  const ada = app.browser()

  await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

  return { ...app, ada }
}

describe('changing the password', () => {
  test('needs the current one, keeps this session and ends the others', async () => {
    const { ada, browser } = await registered()
    const elsewhere = browser()

    await elsewhere.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('changePassword', { password: 'wrong password!' }, 'a brand new password')).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('changePassword', { password: PASSWORD }, 'short')).toEqual({ ok: false, errors: { password: 'too-short' } })
    expect(await ada.call('changePassword', { password: PASSWORD }, 'a brand new password')).toEqual({ ok: true })

    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect(await elsewhere.json('/me')).toBe('anonymous')
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: 'a brand new password' })).toMatchObject({ ok: true })
  })

  test('stops guessing at the current password after six tries', async () => {
    const { ada } = await registered()

    for (let attempt = 0; attempt < 6; attempt++)
      await ada.call('changePassword', { password: 'wrong password!' }, 'a brand new password')

    expect(await ada.call('changePassword', { password: PASSWORD }, 'a brand new password')).toEqual({ ok: false, error: 'limited' })
  })
})

describe('an account with neither a password nor a second factor', () => {
  async function passwordless() {
    const app = testApp()

    await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    const ada = app.browser()

    await ada.fetch('/sign-in/u1', POST)

    return { ...app, ada }
  }

  test('sets a first password right after signing in', async () => {
    const { ada } = await passwordless()

    expect(await ada.call('changePassword', {}, 'a first password')).toEqual({ ok: true })
    expect(await ada.json('/me')).toMatchObject({ hasPassword: true })
  })

  test('asks to sign in again once the sign-in is ten minutes old, so a stolen session cannot take the account over', async () => {
    const { ada } = await passwordless()

    setSystemTime(Date.now() + 11 * 60 * 1000)

    expect(await ada.call('changePassword', {}, 'a first password')).toEqual({ ok: false, error: 'stale' })
    expect(await ada.call('changeEmail', {}, 'thief@example.com')).toEqual({ ok: false, error: 'stale' })
  })
})

describe('changing the username', () => {
  test('names a user without one, the name then signing in, and lets them recase it', async () => {
    const { ada, browser } = await registered()

    expect(await ada.call('changeUsername', ' Ada  Lovelace ')).toMatchObject({ ok: true, user: { username: 'Ada Lovelace' } })
    expect(await ada.json('/me')).toMatchObject({ username: 'Ada Lovelace' })
    expect(await browser().post('/password', { identifier: 'ada lovelace', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await ada.call('changeUsername', 'ada lovelace')).toMatchObject({ ok: true, user: { username: 'ada lovelace' } })
  })

  test('refuses a name the rules refuse, one another user has in any case, the same one, and a visitor', async () => {
    const { ada, browser, store } = await registered()

    await store.users.create(userRecord({ id: 'u2', username: 'Bob' }))
    await ada.call('changeUsername', 'ada')

    expect(await ada.call('changeUsername', 'a')).toEqual({ ok: false, errors: { username: 'length' } })
    expect(await ada.call('changeUsername', 'bob')).toEqual({ ok: false, errors: { username: 'taken' } })
    expect(await ada.call('changeUsername', 'ada')).toEqual({ ok: false, errors: { username: 'unchanged' } })
    expect(await browser().call('changeUsername', 'carol')).toEqual({ ok: false, error: 'signed-out' })
  })

  test('answers taken for a name another request took in between', async () => {
    const { ada, store } = await registered()
    const update = store.users.update

    store.users.update = async () => {
      await store.users.create(userRecord({ id: 'u2', username: 'Ada' }))

      throw new Error('unique violation')
    }

    expect(await ada.call('changeUsername', 'ada')).toEqual({ ok: false, errors: { username: 'taken' } })
    store.users.update = update
  })

  test('shows the new name to the rest of the same request', async () => {
    const { app, browser } = testApp()
    const ada = browser()

    // Added before the first request, which compiles the routes.
    app.post('/rename', async ({ auth }) => {
      await auth.changeUsername('ada')

      return auth.user()
    })
    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(await (await ada.fetch('/rename', POST)).json()).toMatchObject({ username: 'ada' })
  })
})

describe('unlinking a provider', () => {
  test('refuses to unlink the last way in, and allows it once there is a password', async () => {
    const app = testApp()

    await app.store.users.create(userRecord({ id: 'u1' }))
    await app.store.identities.create({ provider: 'discord', providerId: '1', userId: 'u1', accessToken: null, refreshToken: null, tokenExpiresAt: null, createdAt: new Date() })
    const ada = app.browser()

    await ada.fetch('/sign-in/u1', POST)

    expect(await ada.call('identities')).toEqual(['discord'])
    expect(await ada.call('unlink', 'github', {})).toEqual({ ok: false, error: 'not-linked' })
    expect(await ada.call('unlink', 'discord', {})).toEqual({ ok: false, error: 'last-way-in' })

    await ada.call('changePassword', {}, 'a first password')

    expect(await ada.call('unlink', 'discord', { password: 'a first password' })).toEqual({ ok: true })
    expect(await ada.call('identities')).toEqual([])
  })
})

describe('deleting the account', () => {
  test('needs the password, deletes the user, tells the app and signs out', async () => {
    const deleted: User[] = []
    const { ada, browser, store } = await registered({
      onDelete: (user) => {
        deleted.push(user)
      },
    })

    expect(await ada.call('deleteAccount', { password: 'wrong password!' })).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })

    expect(await ada.json('/me')).toBe('anonymous')
    expect(deleted.map(user => user.email)).toEqual(['ada@example.com'])
    expect(await store.users.findByEmail('ada@example.com')).toBeUndefined()
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'invalid' })
  })

  test('with a second factor and no password, takes a code', async () => {
    const app = testApp()

    await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    const ada = app.browser()

    await ada.fetch('/sign-in/u1', POST)
    const { setup } = await ada.call('setUpTwoFactor', {})
    const { totpCode, totpStep } = await import('../src/totp')

    await ada.call('enableTwoFactor', await totpCode(setup.secret, totpStep()))

    expect(await ada.call('deleteAccount', {})).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('deleteAccount', { code: await totpCode(setup.secret, totpStep() + 1) })).toEqual({ ok: true })
  })
})
