import type { AuthEvent } from '../src/events'
import type { Proof } from '../src/twoFactor'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { totpCode, totpStep } from '../src/totp'
import { testApp, userRecord } from './helpers/app'
import { authenticator } from './helpers/authenticator'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'

afterEach(() => {
  setSystemTime()
})

async function setup(passkeys?: NonNullable<Parameters<typeof testApp>[0]>['passkeys'], extra: Parameters<typeof testApp>[0] = {}) {
  const events: { event: AuthEvent, detail: string | undefined }[] = []
  const app = testApp({
    url: 'https://site.test',
    site: 'Site',
    ...passkeys && { passkeys },
    ...extra,
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

async function addPasskey(browser: Browser, device = authenticator(), name?: string, proof: Proof = { password: PASSWORD }) {
  const { options } = await browser.callOk('passkeyRegistrationOptions', proof)
  const added = await browser.callOk('registerPasskey', await device.create(options), name)

  return { device, added }
}

async function passkeySignIn(browser: Browser, device: ReturnType<typeof authenticator>, answer: Parameters<ReturnType<typeof authenticator>['get']>[1] = {}, redirect?: string) {
  const options = await browser.call('passkeySignInOptions')

  return browser.call('signInWithPasskey', await device.get(options, answer), { redirect })
}

describe('registering passkeys', () => {
  test('a name loses its control and direction characters', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { added } = await addPasskey(ada, authenticator(), ' Ph\none\u202E\u0000 ')

    expect(added.passkey.name).toBe('Phone')
  })

  test('a signed-in user adds a passkey kept on the authenticator, named as they choose, and is mailed', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { options } = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })

    expect(options).toMatchObject({ rp: { id: 'site.test', name: 'Site' }, authenticatorSelection: { residentKey: 'required' }, attestation: 'none' })

    const device = authenticator({ synced: true })
    const added = await ada.callOk('registerPasskey', await device.create(options), '  Phone  ')

    expect(added).toMatchObject({ ok: true, passkey: { name: 'Phone', multiDevice: true, backedUp: true, lastUsedAt: null } })
    expect(await ada.call('passkeys')).toMatchObject([{ id: device.credentials[0]!.id, name: 'Phone' }])
    expect(app.events.at(-1)).toEqual({ event: 'passkey-added', detail: 'Phone' })

    const second = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })

    // The authenticator is told which passkeys it holds already.
    expect(second.options.excludeCredentials).toMatchObject([{ id: device.credentials[0]!.id }])
  })

  test('without a name, the passkey takes the browser and system it was made on', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { options } = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })
    const response = await authenticator().create(options)
    const added = await ada.callOk('registerPasskey', response)

    expect(added.passkey.name).toBe('Passkey')

    const next = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })
    const named = await ada.json('/call/registerPasskey', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' },
      body: JSON.stringify([await authenticator().create(next.options)]),
    }) as { passkey: { name: string } }

    expect(named.passkey.name).toBe('Safari on macOS')
  })

  test('a registration challenge is spent once', async () => {
    const app = await setup()
    const ada = await registered(app)

    const { options } = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })
    const response = await authenticator().create(options)

    expect(await ada.call('registerPasskey', response)).toMatchObject({ ok: true })
    expect(await ada.call('registerPasskey', response)).toEqual({ ok: false, error: 'expired' })
  })

  test('with two-factor on, the password alone adds none: a code or a passkey does', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { setup: twoFactor } = await ada.callOk('setUpTwoFactor', { password: PASSWORD })
    const { recoveryCodes } = await ada.callOk('enableTwoFactor', await totpCode(twoFactor.secret, totpStep()))

    expect(await ada.call('passkeyRegistrationOptions', { password: PASSWORD })).toEqual({ ok: false, error: 'proof' })

    const { device } = await addPasskey(ada, authenticator(), undefined, { code: recoveryCodes[0]! })
    const proof = await ada.callOk('passkeyProofOptions')

    expect(await addPasskey(ada, authenticator(), undefined, { passkey: await device.get(proof.options) })).toMatchObject({ added: { ok: true } })
    expect(await ada.call('passkeys')).toHaveLength(2)
  })

  test('a passkey made for another site, or answering another challenge, is refused', async () => {
    const app = await setup()
    const ada = await registered(app)
    const first = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })

    expect(await ada.call('registerPasskey', await authenticator({ origin: 'https://evil.test' }).create(first.options))).toEqual({ ok: false, error: 'invalid' })

    const second = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })

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
    expect(await visitor.call('signInWithPasskey', await device.get(options), { redirect: '//evil.test' })).toEqual({ ok: true, redirect: '/' })
    expect(await visitor.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect((await visitor.call('passkeys'))[0]!.lastUsedAt).not.toBeNull()
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
  test('guesses at the passkey second factor past the account\'s cap mail the holder once, as code guesses do', async () => {
    const box = mailbox()
    const app = await setup(undefined, { limits: { twoFactorAccount: { max: 2, window: 900 } }, email: { mailer: box.mailer, links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }, requireVerified: false } })

    await addPasskey(await registered(app))

    const user = (await app.store.users.findByEmail('ada@example.com'))!

    await app.store.users.update(user.id, { totpEnabledAt: new Date(), emailVerifiedAt: new Date() })

    const visitor = app.browser()

    await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    const answers: unknown[] = []

    for (let guess = 0; guess < 5; guess++)
      answers.push(await visitor.call('verifyTwoFactorPasskey', {} as never))

    expect(answers.at(-1)).toEqual({ ok: false, error: 'limited' })
    await Bun.sleep(20)
    expect(box.mails.filter(mail => mail.kind === 'sign-in-locked').map(mail => mail.to)).toEqual(['ada@example.com'])
  })

  test('a sign-in waiting for its second factor takes a passkey in place of a code', async () => {
    const app = await setup()
    const { device } = await addPasskey(await registered(app))
    const user = await app.store.users.findByEmail('ada@example.com')

    await app.store.users.update(user!.id, { totpEnabledAt: new Date() })

    const visitor = app.browser()

    expect(await visitor.call('twoFactorPasskeyOptions')).toEqual({ ok: false, error: 'expired' })
    expect(await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true, redirect: '/two-factor' })

    const { options } = await visitor.callOk('twoFactorPasskeyOptions')

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

    const { options } = await ada.callOk('passkeyProofOptions')

    expect(await ada.call('reprove', { passkey: await device.get(options) })).toEqual({ ok: true })

    const again = await ada.callOk('passkeyProofOptions')

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

    const { options } = await ada.callOk('passkeyProofOptions')

    expect(await ada.call('removePasskey', device.credentials[0]!.id, { passkey: await device.get(options) })).toEqual({ ok: false, error: 'last-way-in' })
  })

  test('a passkey that never proved user verification is no way in, and is listed as such', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { device } = await addPasskey(ada)
    const user = await app.store.users.findByEmail('ada@example.com')
    const id = device.credentials[0]!.id

    await app.store.users.update(user!.id, { passwordHash: null })
    await app.store.identities.create({ provider: 'discord', providerId: '1', userId: user!.id, accessToken: null, refreshToken: null, tokenExpiresAt: null, createdAt: new Date() })
    await app.store.passkeys.update(id, { userVerified: false })

    expect(await ada.call('passkeys')).toMatchObject([{ userVerified: false }])
    expect(await ada.call('unlink', 'discord', {})).toEqual({ ok: false, error: 'last-way-in' })
    expect(await ada.call('removePasskey', id, {})).toEqual({ ok: true })
    expect(await ada.call('unlink', 'discord', {})).toEqual({ ok: false, error: 'last-way-in' })
  })

  test('a sole passkey that is not proven stays while it is the only way in', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { device } = await addPasskey(ada)
    const user = await app.store.users.findByEmail('ada@example.com')
    const id = device.credentials[0]!.id

    await app.store.users.update(user!.id, { passwordHash: null })
    await app.store.passkeys.update(id, { userVerified: false })

    expect(await ada.call('removePasskey', id, {})).toEqual({ ok: false, error: 'last-way-in' })
    expect(await ada.call('passkeys')).toHaveLength(1)
  })

  test('a user-verified sign-in proves a stored passkey, which then counts as a way in', async () => {
    const app = await setup()
    const ada = await registered(app)
    const { device } = await addPasskey(ada)
    const user = await app.store.users.findByEmail('ada@example.com')
    const id = device.credentials[0]!.id

    await app.store.users.update(user!.id, { passwordHash: null })
    await app.store.passkeys.update(id, { userVerified: false })

    const { options } = await ada.callOk('passkeyProofOptions')

    expect(await ada.call('reprove', { passkey: await device.get(options) })).toEqual({ ok: true })
    expect(await ada.call('passkeys')).toMatchObject([{ userVerified: true }])

    const again = await ada.callOk('passkeyProofOptions')

    expect(await ada.call('removePasskey', id, { passkey: await device.get(again.options) })).toEqual({ ok: false, error: 'last-way-in' })
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

describe('passkey options', () => {
  test('rpName names the site to the authenticator, the site by default', async () => {
    const named = await registered(await setup({ rpName: 'Acme Inc' }))
    const plain = await registered(await setup())

    expect((await named.callOk('passkeyRegistrationOptions', { password: PASSWORD })).options.rp).toEqual({ id: 'site.test', name: 'Acme Inc' })
    expect((await plain.callOk('passkeyRegistrationOptions', { password: PASSWORD })).options.rp.name).toBe('Site')
  })

  test('registering, sign-in and re-proof always require user verification, whatever userVerification says', async () => {
    for (const level of ['required', 'preferred', 'discouraged'] as const) {
      const app = await setup({ userVerification: level })
      const ada = await registered(app)
      const { options } = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })

      expect(options.authenticatorSelection?.userVerification).toBe('required')
      expect((await app.browser().call('passkeySignInOptions')).userVerification).toBe('required')
    }

    const lax = await registered(await setup({ userVerification: 'discouraged' }))
    const registration = await lax.callOk('passkeyRegistrationOptions', { password: PASSWORD })

    expect(await lax.call('registerPasskey', await authenticator().create(registration.options, { userVerified: false }))).toEqual({ ok: false, error: 'invalid' })
    expect(await lax.call('passkeys')).toEqual([])
  })

  test('required refuses a passkey made without user verification and a second factor answered without it', async () => {
    const app = await setup({ userVerification: 'required' })
    const ada = await registered(app)
    const { options } = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })

    expect(await ada.call('registerPasskey', await authenticator().create(options, { userVerified: false }))).toEqual({ ok: false, error: 'invalid' })

    const { device } = await addPasskey(ada)
    const user = await app.store.users.findByEmail('ada@example.com')

    await app.store.users.update(user!.id, { totpEnabledAt: new Date() })

    const visitor = app.browser()

    await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    const second = await visitor.callOk('twoFactorPasskeyOptions')

    expect(second.options.userVerification).toBe('required')
    expect(await visitor.call('verifyTwoFactorPasskey', await device.get(second.options, { userVerified: false }))).toEqual({ ok: false, error: 'invalid' })
  })

  test('discouraged takes a second factor answered without user verification', async () => {
    const app = await setup({ userVerification: 'discouraged' })
    const { device } = await addPasskey(await registered(app))
    const user = await app.store.users.findByEmail('ada@example.com')

    await app.store.users.update(user!.id, { totpEnabledAt: new Date() })

    const visitor = app.browser()

    await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    const { options } = await visitor.callOk('twoFactorPasskeyOptions')

    expect(options.userVerification).toBe('discouraged')
    expect(await visitor.call('verifyTwoFactorPasskey', await device.get(options, { userVerified: false }))).toEqual({ ok: true, redirect: '/' })
  })
})
