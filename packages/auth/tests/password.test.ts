import type { User } from '../src/auth'
import { describe, expect, test } from 'bun:test'
import { serialStore, testApp, userRecord } from './helpers/app'

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

describe('register', () => {
  test('goes on with the id a store picked itself', async () => {
    const { browser, signUps } = setup({ store: serialStore() })
    const ada = browser()

    await browser().post('/register', { email: 'bob@example.com', password: PASSWORD })
    await ada.post('/register', { email: 'ada@example.com', password: PASSWORD })

    expect([await ada.json('/me'), signUps.at(-1)?.id]).toEqual([expect.objectContaining({ id: '2', email: 'ada@example.com' }), '2'])
  })

  test('creates a user with a hashed password and signs them in', async () => {
    const { browser, signUps, store } = setup()
    const ada = browser()
    const result = await ada.post('/register', { email: ' Ada@Example.com ', password: PASSWORD, username: 'Ada' })

    expect(result).toMatchObject({ ok: true, user: { email: 'ada@example.com', username: 'Ada', hasPassword: true, emailVerified: false } })
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect(signUps).toHaveLength(1)
    expect((await store.users.findByEmail('ada@example.com'))?.passwordHash).toStartWith('$argon2id$')
  })

  test('answers each refused field with a code', async () => {
    const { browser, signUps } = setup()
    const result = await browser().post('/register', { email: 'not-an-email', password: 'short', username: 'аlice' })

    expect(result).toEqual({ ok: false, errors: { email: 'invalid', password: 'too-short', username: 'mixed-scripts' } })
    expect(signUps).toEqual([])
  })

  test('refuses an email or a name another user has, whatever their case', async () => {
    const { browser, store } = setup()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', username: 'Ada' }))

    expect(await browser().post('/register', { email: 'ADA@example.com', password: PASSWORD })).toEqual({ ok: false, errors: { email: 'taken' } })
    expect(await browser().post('/register', { email: 'bob@example.com', password: PASSWORD, username: 'ada' })).toEqual({ ok: false, errors: { username: 'taken' } })
  })

  test('limits how many accounts one client creates', async () => {
    const { browser } = setup({ limits: { register: { max: 2, window: 3600 } } })

    for (const name of ['a', 'b'])
      expect(await browser().post('/register', { email: `${name}@example.com`, password: PASSWORD })).toMatchObject({ ok: true })

    expect(await browser().post('/register', { email: 'c@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'limited' })
  })
})

describe('signInWithPassword', () => {
  async function registered(options: Parameters<typeof testApp>[0] = {}) {
    const setupApp = setup(options)

    await setupApp.browser().post('/register', { email: 'ada@example.com', password: PASSWORD, username: 'Ada' })

    return setupApp
  }

  test('signs in by email or by username, and goes where asked on the site', async () => {
    const { browser } = await registered()
    const byEmail = browser()
    const byName = browser()

    expect(await byEmail.post('/password', { identifier: 'ADA@example.com', password: PASSWORD, redirect: '/account' })).toEqual({ ok: true, redirect: '/account' })
    expect(await byEmail.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect(await byName.post('/password', { identifier: 'ada', password: PASSWORD, redirect: 'https://evil.test' })).toEqual({ ok: true, redirect: '/' })
  })

  test('a wrong password and an unknown account answer alike', async () => {
    const { browser } = await registered()
    const visitor = browser()

    expect(await visitor.post('/password', { identifier: 'ada@example.com', password: 'wrong password!' })).toEqual({ ok: false, error: 'invalid' })
    expect(await visitor.post('/password', { identifier: 'nobody@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'invalid' })
    expect(await visitor.json('/me')).toBe('anonymous')
  })

  test('an account without a password cannot be signed into with one', async () => {
    const { browser, store } = setup()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))

    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'invalid' })
  })

  test('stops an account after its failed attempts, even with the right password, and a success clears them', async () => {
    const { browser } = await registered({ limits: { signInAccount: { max: 2, window: 900 } } })
    const visitor = browser()

    await visitor.post('/password', { identifier: 'ada@example.com', password: 'wrong password!' })
    expect(await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })

    await visitor.post('/password', { identifier: 'ada@example.com', password: 'wrong password!' })
    await visitor.post('/password', { identifier: 'ada@example.com', password: 'wrong password!' })

    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'limited' })
  })

  test('counts an account once however it is named, by its email or by its name in any case', async () => {
    const { browser } = await registered({ limits: { signInAccount: { max: 3, window: 900 } } })

    for (const identifier of ['ada@example.com', 'Ada', 'ADA'])
      expect(await browser().post('/password', { identifier, password: 'wrong password!' })).toEqual({ ok: false, error: 'invalid' })

    expect(await browser().post('/password', { identifier: 'ada', password: PASSWORD })).toEqual({ ok: false, error: 'limited' })
  })

  test('counts a burst of parallel guesses before any password is checked', async () => {
    const { browser } = await registered({ limits: { signInAccount: { max: 2, window: 900 } } })
    const answers = await Promise.all(Array.from({ length: 6 }, () => browser().post('/password', { identifier: 'ada@example.com', password: 'wrong password!' })))

    expect(answers.filter(answer => answer.error === 'invalid')).toHaveLength(2)
  })

  test('stops a client after its attempts, whichever accounts it tries', async () => {
    const { browser } = await registered({ limits: { signIn: { max: 2, window: 900 } } })

    await browser().post('/password', { identifier: 'a@example.com', password: PASSWORD })
    await browser().post('/password', { identifier: 'b@example.com', password: PASSWORD })

    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'limited' })
  })

  test('counts each client apart, as kay reads its address', async () => {
    const { browser } = await registered({ limits: { signIn: { max: 1, window: 900 } } })
    const from = (address: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': address }, body: JSON.stringify({ identifier: 'ada@example.com', password: PASSWORD }) })

    expect(await browser().json('/password', from('10.0.0.1'))).toMatchObject({ ok: true })
    expect(await browser().json('/password', from('10.0.0.1'))).toEqual({ ok: false, error: 'limited' })
    expect(await browser().json('/password', from('10.0.0.2'))).toMatchObject({ ok: true })
  })

  test('rehashes a bcrypt password with argon2id on sign-in', async () => {
    const { browser, store } = setup()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', passwordHash: await Bun.password.hash(PASSWORD, { algorithm: 'bcrypt', cost: 4 }) }))

    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect((await store.users.get('u1'))?.passwordHash).toStartWith('$argon2id$')
  })

  test('refuses a password past the longest allowed', async () => {
    const { browser } = await registered()

    expect(await browser().post('/password', { identifier: 'ada@example.com', password: 'x'.repeat(10_000) })).toEqual({ ok: false, error: 'invalid' })
  })
})
