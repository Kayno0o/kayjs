import type { AuthEvent } from '../src/events'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { testApp, userRecord } from './helpers/app'
import { authenticator } from './helpers/authenticator'

const PASSWORD = 'correct horse battery'

afterEach(() => {
  setSystemTime()
})

async function setup() {
  const events: { event: AuthEvent, detail: string | undefined }[] = []
  const app = testApp({
    url: 'https://site.test',
    site: 'Site',
    onEvent: (event, _user, detail) => {
      events.push({ event, detail })
    },
  })

  return { ...app, events }
}

type Browser = ReturnType<Awaited<ReturnType<typeof setup>>['browser']>

// A user with a password, signed in in the browser answered.
async function registered(app: Awaited<ReturnType<typeof setup>>, email = 'ada@example.com') {
  const browser = app.browser()

  await browser.call('register', { email, password: PASSWORD })

  return browser
}

async function addPasskey(browser: Browser, device = authenticator(), name?: string) {
  const { options } = await browser.call('passkeyRegistrationOptions')
  const added = await browser.call('registerPasskey', await device.create(options), name)

  return { device, added }
}

async function passkeySignIn(browser: Browser, device: ReturnType<typeof authenticator>, answer: Parameters<ReturnType<typeof authenticator>['get']>[1] = {}, redirect?: string) {
  const options = await browser.call('passkeySignInOptions')

  return browser.call('signInWithPasskey', await device.get(options, answer), redirect)
}

describe('registering passkeys', () => {
  test('a signed-in user adds a passkey kept on the authenticator, named as they choose, and is mailed', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { options } = await ada.call('passkeyRegistrationOptions')

    expect(options).toMatchObject({ rp: { id: 'site.test', name: 'Site' }, authenticatorSelection: { residentKey: 'required' }, attestation: 'none' })

    const device = authenticator({ synced: true })
    const added = await ada.call('registerPasskey', await device.create(options), '  Phone  ')

    expect(added).toMatchObject({ ok: true, passkey: { name: 'Phone', multiDevice: true, backedUp: true, lastUsedAt: null } })
    expect(await ada.call('passkeys')).toMatchObject([{ id: device.credentials[0]!.id, name: 'Phone' }])
    expect(app.events.at(-1)).toEqual({ event: 'passkey-added', detail: 'Phone' })

    const second = await ada.call('passkeyRegistrationOptions')

    // The authenticator is told which passkeys it holds already.
    expect(second.options.excludeCredentials).toMatchObject([{ id: device.credentials[0]!.id }])
  })

  test('without a name, the passkey takes the browser and system it was made on', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { options } = await ada.call('passkeyRegistrationOptions')
    const response = await authenticator().create(options)
    const added = await ada.call('registerPasskey', response)

    expect(added.passkey.name).toBe('Passkey')

    const next = await ada.call('passkeyRegistrationOptions')
    const named = await ada.json('/call/registerPasskey', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' },
      body: JSON.stringify([await authenticator().create(next.options)]),
    }) as { passkey: { name: string } }

    expect(named.passkey.name).toBe('Safari on macOS')
  })

  test('adding one needs a session that signed in or re-proved in the last ten minutes, and a challenge spent once', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { options } = await ada.call('passkeyRegistrationOptions')
    const response = await authenticator().create(options)

    expect(await ada.call('registerPasskey', response)).toMatchObject({ ok: true })
    expect(await ada.call('registerPasskey', response)).toEqual({ ok: false, error: 'expired' })

    setSystemTime(new Date(Date.now() + 11 * 60 * 1000))

    expect(await ada.call('passkeyRegistrationOptions')).toEqual({ ok: false, error: 'stale' })
    expect(await app.browser().call('passkeyRegistrationOptions')).toEqual({ ok: false, error: 'signed-out' })
  })

  test('a passkey made for another site, or answering another challenge, is refused', async () => {
    const app = await setup()
    const ada = await registered(app)
    const first = await ada.call('passkeyRegistrationOptions')

    expect(await ada.call('registerPasskey', await authenticator({ origin: 'https://evil.test' }).create(first.options))).toEqual({ ok: false, error: 'invalid' })

    const second = await ada.call('passkeyRegistrationOptions')

    expect(await ada.call('registerPasskey', await authenticator().create({ ...second.options, challenge: first.options.challenge }))).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.call('passkeys')).toEqual([])
  })
})

describe('signing in with a passkey', () => {
  test('a passkey alone signs in, the account named by the authenticator, with no second factor after it', async () => {
    const app = await setup()
    const { device } = await addPasskey(await registered(app))
    const user = await app.store.users.findByEmail('ada@example.com')

    await app.store.users.update(user!.id, { totpEnabledAt: new Date() })

    const visitor = app.browser()
    const options = await visitor.call('passkeySignInOptions')

    expect(options.allowCredentials).toBeUndefined()
    expect(options.userVerification).toBe('required')
    expect(await visitor.call('signInWithPasskey', await device.get(options), '//evil.test')).toEqual({ ok: true, redirect: '/' })
    expect(await visitor.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect((await visitor.call('passkeys'))[0].lastUsedAt).not.toBeNull()
  })

  test('a replayed answer, one without user verification, or one from a cloned authenticator signs nobody in', async () => {
    const app = await setup()
    const { device } = await addPasskey(await registered(app))
    const visitor = app.browser()
    const options = await visitor.call('passkeySignInOptions')
    const response = await device.get(options)

    expect(await visitor.call('signInWithPasskey', response)).toMatchObject({ ok: true })
    expect(await visitor.call('signInWithPasskey', response)).toEqual({ ok: false, error: 'expired' })
    expect(await passkeySignIn(app.browser(), device, { userVerified: false })).toEqual({ ok: false, error: 'invalid' })

    // The store holds the counter at 1: a copy of the key still counting from there gives itself away.
    expect(await passkeySignIn(app.browser(), device, { counter: 1 })).toEqual({ ok: false, error: 'invalid' })
    expect(await passkeySignIn(app.browser(), device)).toMatchObject({ ok: true })
  })

  test('an answer to another browser\'s challenge, or from a passkey nobody holds, signs nobody in', async () => {
    const app = await setup()
    const { device } = await addPasskey(await registered(app))
    const thief = app.browser()
    const victim = app.browser()
    const stolen = await victim.call('passkeySignInOptions')

    await thief.call('passkeySignInOptions')

    expect(await thief.call('signInWithPasskey', await device.get(stolen))).toEqual({ ok: false, error: 'invalid' })
    expect(await thief.json('/me')).toBe('anonymous')

    const stranger = authenticator()
    const other = await registered(app, 'bob@example.com')

    await addPasskey(other, stranger)
    await app.store.passkeys.delete((await app.store.users.findByEmail('bob@example.com'))!.id, stranger.credentials[0]!.id)

    expect(await passkeySignIn(app.browser(), stranger)).toEqual({ ok: false, error: 'invalid' })
  })

  test('a passkey stored under another account than the one the authenticator names signs nobody in', async () => {
    const app = await setup()
    const { device } = await addPasskey(await registered(app))
    const passkey = (await app.store.passkeys.get(device.credentials[0]!.id))!

    await app.store.users.create(userRecord({ id: 'eve' }))
    await app.store.passkeys.delete(passkey.userId, passkey.id)
    await app.store.passkeys.create({ ...passkey, userId: 'eve' })

    expect(await passkeySignIn(app.browser(), device)).toEqual({ ok: false, error: 'invalid' })
  })
})

describe('a passkey as second factor and as proof', () => {
  test('a sign-in waiting for its second factor takes a passkey in place of a code', async () => {
    const app = await setup()
    const { device } = await addPasskey(await registered(app))
    const user = await app.store.users.findByEmail('ada@example.com')

    await app.store.users.update(user!.id, { totpEnabledAt: new Date() })

    const visitor = app.browser()

    expect(await visitor.call('twoFactorPasskeyOptions')).toEqual({ ok: false, error: 'expired' })
    expect(await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true, redirect: '/two-factor' })

    const { options } = await visitor.call('twoFactorPasskeyOptions')

    expect(options.allowCredentials).toMatchObject([{ id: device.credentials[0]!.id }])
    expect(await visitor.call('verifyTwoFactorPasskey', await device.get(options, { userVerified: false }))).toEqual({ ok: true, redirect: '/' })
    expect(await visitor.json('/me')).toMatchObject({ email: 'ada@example.com' })
  })

  test('a passkey re-proves the user, for removing one included, and a removal is mailed', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { device } = await addPasskey(ada, authenticator(), 'Laptop')
    const id = device.credentials[0]!.id

    expect(await ada.call('removePasskey', id, { password: 'wrong' })).toEqual({ ok: false, error: 'proof' })

    const { options } = await ada.call('passkeyProofOptions')

    expect(await ada.call('reprove', { passkey: await device.get(options) })).toEqual({ ok: true })

    const again = await ada.call('passkeyProofOptions')

    expect(await ada.call('removePasskey', id, { passkey: await device.get(again.options) })).toEqual({ ok: true })
    expect(await ada.call('passkeys')).toEqual([])
    expect(app.events.at(-1)).toEqual({ event: 'passkey-removed', detail: 'Laptop' })
  })

  test('the last passkey of an account with no other way in stays', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { device } = await addPasskey(ada)
    const user = await app.store.users.findByEmail('ada@example.com')

    await app.store.users.update(user!.id, { passwordHash: null })

    const { options } = await ada.call('passkeyProofOptions')

    expect(await ada.call('removePasskey', device.credentials[0]!.id, { passkey: await device.get(options) })).toEqual({ ok: false, error: 'last-way-in' })
  })

  test('a passkey is renamed by its owner only', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { device } = await addPasskey(ada)
    const bob = await registered(app, 'bob@example.com')
    const id = device.credentials[0]!.id

    expect(await bob.call('renamePasskey', id, 'Mine')).toBe(false)
    expect(await ada.call('renamePasskey', id, ' ')).toBe(false)
    expect(await ada.call('renamePasskey', id, 'Work laptop')).toBe(true)
    expect(await ada.call('passkeys')).toMatchObject([{ name: 'Work laptop' }])
  })
})
