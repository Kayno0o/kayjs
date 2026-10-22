import type { Switches } from '../src/core'
import { describe, expect, test } from 'bun:test'
import { memoryAuthStore } from '../src/memoryStore'
import { totpCode, totpStep } from '../src/totp'
import { hasWayIn } from '../src/wayIn'
import { testApp, userRecord } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const OFF = { ok: false, error: 'off' } as const
const email = () => ({ mailer: mailbox().mailer, links: { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }, requireVerified: false })

describe('feature switches', () => {
  test('are all on by default and in features()', async () => {
    const { browser } = testApp({ url: 'http://localhost', email: email() })

    expect(await browser().call('features')).toMatchObject({ password: true, passkeys: true, magicLink: true, twoFactor: true })
  })

  test('password: false closes registering, signing in, resets and changes', async () => {
    const mails = mailbox()
    const { browser, store } = testApp({ url: 'http://localhost', password: false, email: { ...email(), mailer: mails.mailer } })
    const ada = browser()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))
    await ada.post('/sign-in/u1', {})

    expect(await ada.call('features')).toMatchObject({ password: false, magicLink: true })
    expect(await ada.call('register', { email: 'bob@example.com', password: PASSWORD })).toEqual(OFF)
    expect(await ada.call('signInWithPassword', { identifier: 'ada@example.com', password: PASSWORD })).toEqual(OFF)
    expect(await ada.call('requestPasswordReset', 'ada@example.com')).toEqual(OFF)
    expect(await ada.call('resetPassword', 'token', PASSWORD)).toEqual(OFF)
    expect(await ada.call('changePassword', {}, PASSWORD)).toEqual(OFF)
    expect(await store.users.findByEmail('bob@example.com')).toBeUndefined()
    expect(mails.mails).toHaveLength(0)
  })

  test('magicLink: false closes links and codes, and features() says so even with mail', async () => {
    const mails = mailbox()
    const { browser, store } = testApp({ url: 'http://localhost', magicLink: false, email: { ...email(), mailer: mails.mailer } })
    const ada = browser()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))

    expect(await ada.call('features')).toMatchObject({ email: true, magicLink: false })
    expect(await ada.call('requestMagicLink', 'ada@example.com')).toEqual(OFF)
    expect(await ada.call('signInWithMagicLink', 'token')).toEqual(OFF)
    expect(await ada.call('signInWithEmailCode', '123456')).toEqual(OFF)
    expect(mails.mails).toHaveLength(0)
  })

  test('magicLink is off in features() without mail', async () => {
    expect(await testApp({ url: 'http://localhost' }).browser().call('features')).toMatchObject({ magicLink: false })
  })

  test('twoFactor: false closes setting it up, but a user who has it is still asked for the code', async () => {
    const { browser, store } = testApp({ url: 'http://localhost', twoFactor: false })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('features')).toMatchObject({ twoFactor: false })
    expect(await ada.call('setUpTwoFactor', { password: PASSWORD })).toEqual(OFF)
    expect(await ada.call('enableTwoFactor', '123456')).toEqual(OFF)

    await store.users.update((await store.users.findByEmail('ada@example.com'))!.id, { totpSecret: 'sealed', totpEnabledAt: new Date() })

    const again = browser()

    expect(await again.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await again.call('twoFactorPending')).toBe(true)
  })

  test('twoFactor: false leaves a user who has it the sign-in code, their recovery codes and the way to turn it off', async () => {
    const store = memoryAuthStore()
    const ada = testApp({ store }).browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    const { setup } = await ada.callOk('setUpTwoFactor', { password: PASSWORD })
    const { recoveryCodes } = await ada.callOk('enableTwoFactor', await totpCode(setup.secret, totpStep()))
    const again = testApp({ store, twoFactor: false }).browser()

    expect(await again.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await again.call('twoFactorPending')).toBe(true)
    expect(await again.call('verifyTwoFactor', recoveryCodes[0]!)).toMatchObject({ ok: true })

    const renewed = await again.callOk('regenerateRecoveryCodes', { password: PASSWORD, code: recoveryCodes[1]! })

    expect(await again.call('disableTwoFactor', { password: PASSWORD, code: renewed.recoveryCodes[0]! })).toEqual({ ok: true })
  })

  test('twoFactor: false cannot be asked of forwardAuth, which sends users to set it up', () => {
    expect(() => testApp({ url: 'http://localhost', twoFactor: false, forwardAuth: { domains: 'example.com', requireTwoFactor: true } })).toThrow('twoFactor: false')
    expect(() => testApp({ url: 'http://localhost', forwardAuth: { domains: 'example.com', requireTwoFactor: true } })).not.toThrow()
  })

  test('a way in that is switched off is no way in when a user unlinks or revokes the last', async () => {
    const store = memoryAuthStore()
    const identity = { provider: 'discord', providerId: '1', userId: 'u1', accessToken: null, refreshToken: null, tokenExpiresAt: null, createdAt: new Date() }

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date(), passwordHash: 'hash' }))
    await store.identities.create(identity)
    await store.passkeys.create({ id: 'p1', userId: 'u1', publicKey: new Uint8Array(), counter: 0, transports: [], name: 'Key', userVerified: true, createdAt: new Date() } as never)

    const core = (switches: Partial<Switches>) => ({ store, email: {}, switches: { password: true, passkeys: true, magicLink: true, twoFactor: true, ...switches } }) as never

    expect(await hasWayIn(core({}), 'u1', { identity })).toBe(true)
    expect(await hasWayIn(core({ password: false, magicLink: false, passkeys: false }), 'u1', { identity })).toBe(false)
    expect(await hasWayIn(core({ password: false, magicLink: false }), 'u1', { identity })).toBe(true)
    expect(await hasWayIn(core({ password: false, magicLink: false }), 'u1', { identity: { ...identity, providerId: '2' } })).toBe(true)
  })

  test('passkeys: false closes every passkey method, though the site has an origin', async () => {
    const { browser } = testApp({ url: 'http://localhost', passkeys: false })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('features')).toMatchObject({ passkeys: false })
    expect(await ada.call('passkeyRegistrationOptions', { password: PASSWORD })).toEqual(OFF)
    expect(await ada.call('registerPasskey', {} as never)).toEqual(OFF)
    expect(await ada.call('signInWithPasskey', {} as never)).toEqual(OFF)
    expect(await ada.call('twoFactorPasskeyOptions')).toEqual(OFF)
    expect(await ada.call('verifyTwoFactorPasskey', {} as never)).toEqual(OFF)
    expect(await ada.call('passkeyProofOptions')).toEqual(OFF)
    expect(await ada.call('listPasskeys')).toEqual([])
  })
})
