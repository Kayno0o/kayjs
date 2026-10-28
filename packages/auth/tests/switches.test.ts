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
    const { browser } = testApp({ site: 'http://localhost', email: email() })

    expect(await browser().call('features')).toMatchObject({ password: true, passkeys: true, magicLink: true, twoFactor: true })
  })

  test('password: false closes registering, signing in, resets and changes', async () => {
    const mails = mailbox()
    const { browser, store } = testApp({ site: 'http://localhost', password: false, email: { ...email(), mailer: mails.mailer } })
    const ada = browser()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))
    await ada.post('/sign-in/u1', {})

    expect(await ada.call('features')).toMatchObject({ password: false, magicLink: true })
    expect(await ada.call('password.register', { email: 'bob@example.com', password: PASSWORD })).toEqual(OFF)
    expect(await ada.call('password.signIn', { identifier: 'ada@example.com', password: PASSWORD })).toEqual(OFF)
    expect(await ada.call('password.requestReset', 'ada@example.com')).toEqual(OFF)
    expect(await ada.call('password.reset', 'token', PASSWORD)).toEqual(OFF)
    expect(await ada.call('password.change', {}, PASSWORD)).toEqual(OFF)
    expect(await store.users.findByEmail('bob@example.com')).toBeUndefined()
    expect(mails.mails).toHaveLength(0)
  })

  test('magicLink: false closes links and codes, and features() says so even with mail', async () => {
    const mails = mailbox()
    const { browser, store } = testApp({ site: 'http://localhost', magicLink: false, email: { ...email(), mailer: mails.mailer } })
    const ada = browser()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))

    expect(await ada.call('features')).toMatchObject({ email: true, magicLink: false })
    expect(await ada.call('magicLink.request', 'ada@example.com')).toEqual(OFF)
    expect(await ada.call('magicLink.signIn', 'token')).toEqual(OFF)
    expect(await ada.call('magicLink.signInWithCode', '123456')).toEqual(OFF)
    expect(mails.mails).toHaveLength(0)
  })

  test('magicLink is off in features() without mail', async () => {
    expect(await testApp({ site: 'http://localhost' }).browser().call('features')).toMatchObject({ magicLink: false })
  })

  test('twoFactor: false closes setting it up, but a user who has it is still asked for the code', async () => {
    const { browser, store } = testApp({ site: 'http://localhost', twoFactor: false })
    const ada = browser()

    await ada.call('password.register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('features')).toMatchObject({ twoFactor: false })
    expect(await ada.call('twoFactor.setUp', { password: PASSWORD })).toEqual(OFF)
    expect(await ada.call('twoFactor.enable', '123456')).toEqual(OFF)

    await store.users.update((await store.users.findByEmail('ada@example.com'))!.id, { totpSecret: 'sealed', totpEnabledAt: new Date() })

    const again = browser()

    expect(await again.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await again.call('twoFactor.pending')).toBe(true)
  })

  test('twoFactor: false leaves a user who has it the sign-in code, their recovery codes and the way to turn it off', async () => {
    const store = memoryAuthStore()
    const ada = testApp({ store }).browser()

    await ada.call('password.register', { email: 'ada@example.com', password: PASSWORD })

    const { setup } = await ada.callOk('twoFactor.setUp', { password: PASSWORD })
    const { recoveryCodes } = await ada.callOk('twoFactor.enable', await totpCode(setup.secret, totpStep()))
    const again = testApp({ store, twoFactor: false }).browser()

    expect(await again.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await again.call('twoFactor.pending')).toBe(true)
    expect(await again.call('twoFactor.verify', recoveryCodes[0]!)).toMatchObject({ ok: true })

    const renewed = await again.callOk('twoFactor.regenerateRecoveryCodes', { password: PASSWORD, code: recoveryCodes[1]! })

    expect(await again.call('twoFactor.disable', { password: PASSWORD, code: renewed.recoveryCodes[0]! })).toEqual({ ok: true })
  })

  test('twoFactor: false cannot be asked of forwardAuth, which sends users to set it up', () => {
    expect(() => testApp({ site: 'http://localhost', twoFactor: false, forwardAuth: { domains: 'example.com', requireTwoFactor: true } })).toThrow('twoFactor: false')
    expect(() => testApp({ site: 'http://localhost', forwardAuth: { domains: 'example.com', requireTwoFactor: true } })).not.toThrow()
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
    const { browser } = testApp({ site: 'http://localhost', passkeys: false })
    const ada = browser()

    await ada.call('password.register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('features')).toMatchObject({ passkeys: false })
    expect(await ada.call('passkeys.registrationOptions', { password: PASSWORD })).toEqual(OFF)
    expect(await ada.call('passkeys.register', {} as never)).toEqual(OFF)
    expect(await ada.call('passkeys.signIn', {} as never)).toEqual(OFF)
    expect(await ada.call('twoFactor.passkeyOptions')).toEqual(OFF)
    expect(await ada.call('twoFactor.verifyPasskey', {} as never)).toEqual(OFF)
    expect(await ada.call('passkeys.proofOptions')).toEqual(OFF)
    expect(await ada.call('passkeys.list')).toEqual([])
  })
})
