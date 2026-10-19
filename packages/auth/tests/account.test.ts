import type { User } from '../src/auth'
import type { Proof } from '../src/twoFactor'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { githubProvider } from '../src/oauth/providers'
import { totpCode, totpStep } from '../src/totp'
import { testApp, userRecord } from './helpers/app'
import { authenticator } from './helpers/authenticator'
import { mailbox } from './helpers/mail'

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
  test('needs the current one and sets the new one', async () => {
    const { ada, browser } = await registered()

    expect(await ada.call('changePassword', { password: 'wrong password!' }, 'a brand new password')).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('changePassword', { password: PASSWORD }, 'short')).toEqual({ ok: false, errors: { password: 'too-short' } })
    expect(await ada.call('changePassword', { password: PASSWORD }, 'a brand new password')).toEqual({ ok: true })

    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: 'a brand new password' })).toMatchObject({ ok: true })
  })
})

describe('the actions that re-prove the user', () => {
  type Browser = ReturnType<ReturnType<typeof testApp>['browser']>

  // `codeOnly` is whether an account with a second factor refuses the password alone, as what adds a way in or moves where its reset links go does; changing the password is asked of whoever knows the password.
  const actions: [string, boolean, (ada: Browser, proof: Proof) => Promise<unknown>][] = [
    ['changing the password', false, async (ada, proof) => ada.call('changePassword', proof, 'a first password')],
    ['changing the email', true, async (ada, proof) => ada.call('changeEmail', proof, 'ada@new.test')],
    ['adding a passkey', true, async (ada, proof) => ada.call('passkeyRegistrationOptions', proof)],
    ['linking a provider', true, async (ada, proof) => ada.call('linkProvider', 'github', proof)],
  ]

  // One account of each shape, signed in, with the action's own failures told apart from its refusals by `error`.
  async function shaped(shape: 'bare' | 'password' | 'twoFactor') {
    const app = testApp({
      url: 'https://site.test',
      site: 'Site',
      email: { mailer: mailbox().mailer, links: { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }, requireVerified: false },
      oauth: { github: { provider: githubProvider(), clientId: 'github-id', clientSecret: 'github-secret' } },
    })
    const ada = app.browser()
    let recoveryCodes: string[] = []

    if (shape === 'bare') {
      await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
      await ada.fetch('/sign-in/u1', POST)
    }
    else {
      await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    }

    if (shape === 'twoFactor') {
      const { setup } = await ada.callOk('setUpTwoFactor', { password: PASSWORD })

      recoveryCodes = (await ada.callOk('enableTwoFactor', await totpCode(setup.secret, totpStep()))).recoveryCodes
    }

    return { ...app, ada, recoveryCodes }
  }

  describe.each(actions)('%s', (_name, codeOnly, act) => {
    test('on an account with neither a password nor a second factor, takes a sign-in under ten minutes old, so a stolen session cannot take the account over', async () => {
      const { ada, browser } = await shaped('bare')

      expect(await act(browser(), {})).toEqual({ ok: false, error: 'signed-out' })
      expect(await act(ada, {})).not.toHaveProperty('error')

      // A second account, whose sign-in the clock then ages.
      const old = await shaped('bare')

      setSystemTime(Date.now() + 11 * 60 * 1000)

      expect(await act(old.ada, {})).toEqual({ ok: false, error: 'stale' })
    })

    test('on an account with a password, takes the password, even right after signing in and long after', async () => {
      const { ada } = await shaped('password')

      expect(await act(ada, {})).toEqual({ ok: false, error: 'proof' })
      expect(await act(ada, { password: 'wrong password!' })).toEqual({ ok: false, error: 'proof' })

      setSystemTime(Date.now() + 11 * 60 * 1000)

      expect(await act(ada, { password: PASSWORD })).not.toHaveProperty('error')
    })

    test('on an account with a second factor, takes a code, and the password alone only where it is enough', async () => {
      const { ada, recoveryCodes } = await shaped('twoFactor')

      expect(await act(ada, {})).toEqual({ ok: false, error: 'proof' })

      if (codeOnly) {
        expect(await act(ada, { password: PASSWORD })).toEqual({ ok: false, error: 'proof' })
        expect(await act(ada, { code: recoveryCodes[0]! })).not.toHaveProperty('error')
      }
      else {
        expect(await act(ada, { password: PASSWORD })).not.toHaveProperty('error')
      }
    })
  })
})

describe('changing the email on an account with a second factor', () => {
  // Ada with two-factor on, and the secret her authenticator holds; `password: false` makes the account a passwordless one.
  async function twoFactor({ password = true } = {}) {
    const app = testApp({
      url: 'https://site.test',
      site: 'Site',
      admin: 'admin',
      email: { mailer: mailbox().mailer, links: { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }, requireVerified: false },
    })
    const ada = app.browser()

    if (password) {
      await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    }
    else {
      await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
      await ada.fetch('/sign-in/u1', POST)
    }

    const { setup } = await ada.callOk('setUpTwoFactor', password ? { password: PASSWORD } : {})

    await ada.call('enableTwoFactor', await totpCode(setup.secret, totpStep()))

    return { ...app, ada, secret: setup.secret }
  }

  test('refuses the password alone, takes an authenticator code once, and refuses it spent', async () => {
    const { ada, secret } = await twoFactor()
    const code = await totpCode(secret, totpStep() + 1)

    expect(await ada.call('changeEmail', { password: PASSWORD }, 'ada@new.test')).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('changeEmail', { code }, 'ada@new.test')).not.toHaveProperty('error')
    expect(await ada.call('changeEmail', { code }, 'ada@new.test')).toEqual({ ok: false, error: 'proof' })
  })

  test('takes a passkey', async () => {
    const { ada, secret } = await twoFactor()
    const device = authenticator()
    const { options } = await ada.callOk('passkeyRegistrationOptions', { code: await totpCode(secret, totpStep() + 1) })

    await ada.call('registerPasskey', await device.create(options))

    const proof = await ada.callOk('passkeyProofOptions')

    expect(await ada.call('changeEmail', { passkey: await device.get(proof.options) }, 'ada@new.test')).not.toHaveProperty('error')
  })

  test('asks a passwordless account for the code', async () => {
    const { ada, secret } = await twoFactor({ password: false })

    expect(await ada.call('changeEmail', {}, 'ada@new.test')).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('changeEmail', { code: await totpCode(secret, totpStep() + 1) }, 'ada@new.test')).not.toHaveProperty('error')
  })

  test('refuses an admin acting as the user, code or not', async () => {
    const { ada, browser, store, secret } = await twoFactor()
    const root = browser()
    const { user } = await root.callHas('user', 'register', { email: 'root@example.com', password: PASSWORD })
    const adaId = (await store.users.findByEmail('ada@example.com'))!.id

    await store.users.update(user.id, { roles: ['admin'] })

    expect(await root.call('impersonate', adaId)).toEqual({ ok: true })
    expect(await root.call('changeEmail', { code: await totpCode(secret, totpStep() + 1) }, 'ada@new.test')).toEqual({ ok: false, error: 'impersonating' })
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
  })
})

describe('the profile without pages.profile', () => {
  test('saveProfile throws, as the app asked for a form it did not declare', async () => {
    const { ada } = await registered()

    expect((await ada.fetch('/call/saveProfile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ bio: 'x' }]) })).status).toBe(500)
  })
})

describe('changing the username', () => {
  test('names a user without one, the name then signing in, and lets them recase it', async () => {
    const { ada, browser } = await registered()

    expect(await ada.call('changeUsername', ' Ada  Lovelace ')).toMatchObject({ ok: true, user: { username: 'Ada Lovelace' } })
    expect(await ada.json('/me')).toMatchObject({ username: 'Ada Lovelace' })
    expect(await browser().post('/password', { identifier: 'ada lovelace', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await ada.call('changeUsername', 'ada lovelace')).toMatchObject({ ok: true, user: { username: 'ada lovelace' } })
    await ada.call('changeUsername', 'countess')

    expect(await browser().post('/password', { identifier: 'ada lovelace', password: PASSWORD })).toEqual({ ok: false, error: 'invalid' })
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

  // Each test builds its own store, so the stubs below need no restoring.
  test('answers taken for a name another request took in between, and lets any other store failure through', async () => {
    const { ada, store } = await registered()

    store.users.update = async () => {
      await store.users.create(userRecord({ id: 'u2', username: 'Ada' }))

      throw new Error('unique violation')
    }

    expect(await ada.call('changeUsername', 'ada')).toEqual({ ok: false, errors: { username: 'taken' } })

    store.users.update = async () => {
      throw new Error('connection lost')
    }

    expect((await ada.fetch('/call/changeUsername', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(['carol']) })).status).toBe(500)
  })

  test('refuses a device\'s bearer token, which is no session', async () => {
    const { ada, browser } = await registered()
    const { token } = await ada.callOk('createToken', { password: PASSWORD }, 'Phone')
    const device = browser()

    expect(await device.json('/call/changeUsername', { method: 'POST', headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(['carol']) })).toEqual({ ok: false, error: 'signed-out' })
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

  test('an admin whose deletion fails keeps their roles', async () => {
    const app = testApp({ admin: 'admin', onDelete: () => {
      throw new Error('app down')
    } })
    const ids: string[] = []
    const browsers = []

    for (const email of ['ada@example.com', 'grace@example.com']) {
      const browser = app.browser()
      const { user } = await browser.callHas('user', 'register', { email, password: PASSWORD })

      await app.store.users.update(user.id, { roles: ['admin'] })
      ids.push(user.id)
      browsers.push(browser)
    }

    expect((await browsers[0]!.fetch('/call/deleteAccount', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ password: PASSWORD }]) })).status).toBe(500)
    expect((await app.store.users.get(ids[0]!))?.roles).toEqual(['admin'])
  })

  test('an onDelete that throws leaves the account in place, to delete again', async () => {
    let fail = true
    const { ada, store } = await registered({
      onDelete: () => {
        if (fail)
          throw new Error('app down')
      },
    })

    expect((await ada.fetch('/call/deleteAccount', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ password: PASSWORD }]) })).status).toBe(500)
    expect(await store.users.findByEmail('ada@example.com')).toBeDefined()
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })

    fail = false

    expect(await ada.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await store.users.findByEmail('ada@example.com')).toBeUndefined()
  })

  test('keeps what happened in the audit log, but nothing that leads back to the user', async () => {
    const { ada, browser, store } = await registered({ audit: true })
    const id = (await store.users.findByEmail('ada@example.com'))!.id

    await ada.call('changeEmail', { password: PASSWORD }, 'ada@new.example')
    await browser().post('/password', { identifier: 'ada@example.com', password: 'wrong password!' })

    expect(await ada.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })

    const entries = await store.audit!.list({ limit: 100 })
    const pseudonym = entries[0]!.userId

    expect(entries.map(entry => entry.event)).toContain('account-deleted')
    expect(entries.map(entry => entry.event)).toContain('sign-in-failed')
    expect(pseudonym).not.toBe(id)
    expect(entries.every(entry => entry.userId === pseudonym && entry.ip === '' && entry.userAgent === '' && entry.detail === null)).toBe(true)
  })

  test('refuses the last admin before spending the proof, and lets them go once another admin exists', async () => {
    const { ada, browser, store } = await registered({ admin: 'admin' })
    const adaRecord = (await store.users.findByEmail('ada@example.com'))!

    await store.users.update(adaRecord.id, { roles: ['admin'] })

    expect(await ada.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: false, error: 'last-admin' })
    expect(await store.users.get(adaRecord.id)).toBeTruthy()

    const { user } = await browser().callHas('user', 'register', { email: 'grace@example.com', password: PASSWORD })

    await store.users.update(user.id, { roles: ['admin'] })

    expect(await ada.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
  })

  test('with a second factor and no password, takes a code', async () => {
    const app = testApp()

    await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    const ada = app.browser()

    await ada.fetch('/sign-in/u1', POST)
    const { setup } = await ada.callOk('setUpTwoFactor', {})
    const { totpCode, totpStep } = await import('../src/totp')

    await ada.call('enableTwoFactor', await totpCode(setup.secret, totpStep()))

    expect(await ada.call('deleteAccount', {})).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('deleteAccount', { code: await totpCode(setup.secret, totpStep() + 1) })).toEqual({ ok: true })
  })
})
