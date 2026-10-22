import { describe, expect, test } from 'bun:test'
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
    expect(await ada.call('regenerateRecoveryCodes', { password: PASSWORD })).toEqual(OFF)

    await store.users.update((await store.users.findByEmail('ada@example.com'))!.id, { totpSecret: 'sealed', totpEnabledAt: new Date() })

    const again = browser()

    expect(await again.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await again.call('twoFactorPending')).toBe(true)
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
