import type { CodeMode } from '../src/email'
import type { Mail } from '../src/mail'
import { describe, expect, test } from 'bun:test'
import { testApp, userRecord } from './helpers/app'
import { authenticator } from './helpers/authenticator'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }

function setup(options: { requireVerified?: boolean, defaultRoles?: ('admin' | 'editor')[], codes?: CodeMode } = {}) {
  const { mails, mailer, take } = mailbox()
  const app = testApp({
    defaultRoles: options.defaultRoles,
    url: 'https://site.test/',
    site: 'Site',
    email: {
      mailer,
      links: LINKS,
      requireVerified: options.requireVerified ?? false,
      codes: options.codes,
    },
  })

  // The token the last mail of that kind carries.
  const tokenOf = (kind: Mail['kind']) => new URL(mails.findLast(mail => mail.kind === kind)!.url!).searchParams.get('token')!

  return { ...app, mails, take, tokenOf }
}

describe('verifying an email', () => {
  test('registering mails a link to the app\'s page, and spending it verifies the address', async () => {
    const { browser, mails, tokenOf } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(mails).toHaveLength(1)
    expect(mails[0]).toMatchObject({ to: 'ada@example.com', kind: 'verify-email', site: 'Site', subject: 'Confirm your email for Site' })
    expect(mails[0]!.url).toStartWith('https://site.test/verify?token=')
    expect(mails[0]!.html).toContain(mails[0]!.url!.replaceAll('&', '&amp;'))

    expect(await ada.call('verifyEmail', tokenOf('verify-email'))).toEqual({ ok: true, redirect: '/' })
    expect(await ada.json('/me')).toMatchObject({ emailVerified: true })
  })

  test('a link works once', async () => {
    const { browser, tokenOf } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    const token = tokenOf('verify-email')

    await ada.call('verifyEmail', token)

    expect(await ada.call('verifyEmail', token)).toEqual({ ok: false, error: 'invalid' })
  })

  test('another browser verifies the address only given the password, keeping the link until then, and signs no one in', async () => {
    const { browser, tokenOf } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    const elsewhere = browser()
    const token = tokenOf('verify-email')

    expect(await elsewhere.call('verifyEmail', token)).toEqual({ ok: false, error: 'confirm' })
    expect(await elsewhere.call('verifyEmail', token, 'wrong password!')).toEqual({ ok: false, error: 'confirm' })
    expect(await ada.json('/me')).toMatchObject({ emailVerified: false })
    expect(await elsewhere.call('verifyEmail', token, PASSWORD)).toMatchObject({ ok: true })
    expect(await elsewhere.json('/me')).toBe('anonymous')
    expect(await ada.json('/me')).toMatchObject({ emailVerified: true })
  })

  test('the owner opening the mail a stranger triggered by registering their address leaves that account unverified, for them to claim', async () => {
    const { browser, tokenOf } = setup()
    const stranger = browser()

    await stranger.call('register', { email: 'ada@example.com', password: 'squatter password' })

    expect(await browser().call('verifyEmail', tokenOf('verify-email'))).toEqual({ ok: false, error: 'confirm' })
    expect(await stranger.json('/me')).toMatchObject({ emailVerified: false })
  })

  test('a link the stranger asked for before the owner claimed the account dies with the claim', async () => {
    const { browser, tokenOf } = setup()
    const stranger = browser()

    await stranger.call('register', { email: 'ada@example.com', password: 'squatter password' })
    expect(await stranger.call('changeEmail', { password: 'squatter password' }, 'mallory@evil.test')).toEqual({ ok: true })
    const moving = tokenOf('change-email')
    const ada = browser()

    await ada.call('requestMagicLink', 'ada@example.com')
    await ada.call('signInWithMagicLink', tokenOf('magic-link'))

    expect(await stranger.call('confirmEmailChange', moving)).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
  })

  test('with `requireVerified`, registering signs no one in, and the password waits for the address', async () => {
    const { browser, tokenOf } = setup({ requireVerified: true })
    const ada = browser()

    expect(await ada.call('register', { email: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true, signedIn: false })
    expect(await ada.json('/me')).toBe('anonymous')
    expect(await ada.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'unverified' })

    await ada.call('verifyEmail', tokenOf('verify-email'))

    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
  })

  test('with `requireVerified`, an address someone registered and never verified can be registered again', async () => {
    const { browser, tokenOf } = setup({ requireVerified: true })

    await browser().call('register', { email: 'ada@example.com', password: 'squatter password' })

    const ada = browser()

    expect(await ada.call('register', { email: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    await ada.call('verifyEmail', tokenOf('verify-email'))

    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: 'squatter password' })).toEqual({ ok: false, error: 'invalid' })
  })

  test('with `requireVerified`, an unverified account given roles, as an invited one, is not replaced', async () => {
    const { browser, store } = setup({ requireVerified: true })

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', roles: ['admin'] }))

    expect(await browser().call('register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect(await store.users.get('u1')).toMatchObject({ roles: ['admin'] })
  })

  test('with `requireVerified`, an address already held answers as a free one, leaves the session alike and mails its holder instead', async () => {
    const { browser, store, mails, take } = setup({ requireVerified: true })

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))

    const fresh = browser()
    const held = browser()

    expect(await fresh.call('register', { email: 'bob@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect(await held.call('register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect([...held.cookies.keys()]).toEqual([...fresh.cookies.keys()])
    expect(await held.call('emailCodePending')).toEqual(await fresh.call('emailCodePending'))
    expect(await store.users.get('u1')).toMatchObject({ email: 'ada@example.com', passwordHash: null })
    expect((await take({ to: 'ada@example.com' }))[0]).toMatchObject({ kind: 'account-exists', url: 'https://site.test/', subject: 'You already have a Site account' })

    // The resend button answers alike too, mailing the holder nothing more.
    await take({ to: 'bob@example.com' })
    const sent = mails.length

    expect(await held.call('sendVerification')).toEqual(await fresh.call('sendVerification'))
    expect(await held.call('verifyEmailCode', '000000')).toEqual(await fresh.call('verifyEmailCode', '000000'))
    await take({ to: 'bob@example.com' })
    expect(mails.slice(sent).map(mail => mail.to)).toEqual(['bob@example.com'])
  })

  test('with `requireVerified` and codes, an address already held leaves a code waiting as a free one does', async () => {
    const { browser, store, mails, take } = setup({ requireVerified: true, codes: 'code' })

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))

    const fresh = browser()
    const held = browser()

    expect(await fresh.call('register', { email: 'bob@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect(await held.call('register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect(await held.call('emailCodePending')).toEqual({ type: 'verify', email: 'ada@example.com' })
    expect(await fresh.call('emailCodePending')).toEqual({ type: 'verify', email: 'bob@example.com' })

    // The code dies after five misses, and a resend parks a new one for the address registered, held or not.
    for (let i = 0; i < 5; i++)
      expect(await held.call('verifyEmailCode', '000000')).toEqual(await fresh.call('verifyEmailCode', '000000'))

    expect(await held.call('emailCodePending')).toEqual(await fresh.call('emailCodePending'))
    expect(await held.call('sendVerification')).toEqual(await fresh.call('sendVerification'))
    expect(await held.call('emailCodePending')).toEqual({ type: 'verify', email: 'ada@example.com' })
    expect(await fresh.call('emailCodePending')).toEqual({ type: 'verify', email: 'bob@example.com' })

    // A magic link asked for in between leaves the resend to the address registered too.
    await held.call('requestMagicLink', 'carol@example.com')
    await fresh.call('requestMagicLink', 'carol@example.com')

    expect(await held.call('sendVerification')).toEqual(await fresh.call('sendVerification'))
    expect(await held.call('emailCodePending')).toEqual({ type: 'verify', email: 'ada@example.com' })
    expect(await fresh.call('emailCodePending')).toEqual({ type: 'verify', email: 'bob@example.com' })
    // The registration's and both resends'.
    await take({ to: 'bob@example.com' }, 3)
    expect(mails.filter(mail => mail.to === 'ada@example.com').map(mail => mail.kind)).toEqual(['account-exists'])
  })

  test('with a mailer, addresses must be verified unless the app says otherwise', async () => {
    const { browser } = testApp({ url: 'https://site.test', email: { mailer: { send: () => undefined }, links: LINKS } })
    const { browser: open } = testApp({ url: 'https://site.test', email: { mailer: { send: () => undefined }, links: LINKS, requireVerified: false } })

    expect(await browser().call('register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect(await open().call('register', { email: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true, signedIn: true })
    expect(await testApp().browser().call('register', { email: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true, signedIn: true })
  })

  test('with `requireVerified`, the holder of an address is told at most 3 times an hour', async () => {
    const { browser, store, mails, take } = setup({ requireVerified: true })

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))

    for (let i = 0; i < 4; i++)
      expect(await browser().call('register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })

    await take({ kind: 'account-exists' }, 3)
    expect(mails.filter(mail => mail.kind === 'account-exists')).toHaveLength(3)
  })

  test('with `requireVerified`, an address taken between the check and the write answers as a free one', async () => {
    const { browser, store, mails, take } = setup({ requireVerified: true })
    const findByEmail = store.users.findByEmail.bind(store.users)

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))
    // The first lookup misses, as it would before another request's write.
    store.users.findByEmail = async () => {
      store.users.findByEmail = findByEmail

      return undefined
    }

    expect(await browser().call('register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    await take({ kind: 'account-exists' })
    expect(mails.map(mail => mail.kind)).toEqual(['account-exists'])
  })

  test('with `requireVerified`, an unverified account\'s username is free with its address, and another account\'s is not', async () => {
    const { browser, store } = setup({ requireVerified: true })

    await browser().call('register', { email: 'ada@example.com', username: 'ada', password: 'squatter password' })
    await store.users.create(userRecord({ id: 'u2', email: 'bob@example.com', username: 'bob', emailVerifiedAt: new Date() }))

    expect(await browser().call('register', { email: 'ada@example.com', username: 'ada', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect(await store.users.findByUsername('ada')).toMatchObject({ email: 'ada@example.com' })
    expect(await browser().call('register', { email: 'ada@example.com', username: 'bob', password: PASSWORD })).toEqual({ ok: false, errors: { username: 'taken' } })
  })

  test('with `requireVerified`, a refused registration leaves the unverified holder in place', async () => {
    const { browser, store } = setup({ requireVerified: true })

    await browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    const holder = await store.users.findByEmail('ada@example.com')

    expect(await browser().call('register', { email: 'ada@example.com', password: 'short' })).toMatchObject({ ok: false, errors: { password: 'too-short' } })
    expect(await store.users.findByEmail('ada@example.com')).toEqual(holder)
  })

  test('with `requireVerified`, an unverified account holding only the default roles is replaced, and one holding more is not', async () => {
    const { browser, store } = setup({ requireVerified: true, defaultRoles: ['editor'] })

    await browser().call('register', { email: 'ada@example.com', password: 'squatter password' })
    await store.users.create(userRecord({ id: 'u2', email: 'bob@example.com', roles: ['editor', 'admin'] }))

    expect(await browser().call('register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect(await browser().call('register', { email: 'bob@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect(await store.users.findByEmail('ada@example.com')).toMatchObject({ roles: ['editor'], passwordHash: expect.any(String) })
    expect(await store.users.get('u2')).toMatchObject({ roles: ['editor', 'admin'] })
  })

  test('with `requireVerified`, an unverified account holding only the default roles and a linked provider is not replaced', async () => {
    const { browser, store } = setup({ requireVerified: true, defaultRoles: ['editor'] })

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', roles: ['editor'] }))
    await store.identities.create({ provider: 'discord', providerId: '1', userId: 'u1', accessToken: null, refreshToken: null, tokenExpiresAt: null, createdAt: new Date() })

    expect(await browser().call('register', { email: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, signedIn: false })
    expect(await store.users.get('u1')).toMatchObject({ email: 'ada@example.com' })
  })

  test('resending gives a new link and voids the last', async () => {
    const { browser, tokenOf } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    const first = tokenOf('verify-email')

    expect(await ada.call('sendVerification')).toEqual({ ok: true })
    expect(await ada.call('verifyEmail', first)).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.call('verifyEmail', tokenOf('verify-email'))).toMatchObject({ ok: true })
    expect(await ada.call('sendVerification')).toEqual({ ok: false, error: 'verified' })
  })

  test('with `requireVerified`, a browser that proved the password is told the address is unverified, and may have the link resent and confirm it', async () => {
    const { browser, mails, tokenOf } = setup({ requireVerified: true })

    await browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    const elsewhere = browser()
    const guesser = browser()

    expect(await guesser.post('/password', { identifier: 'ada@example.com', password: 'wrong password!' })).toEqual({ ok: false, error: 'invalid' })
    expect(await guesser.call('sendVerification')).toEqual({ ok: false, error: 'signed-out' })
    expect(await elsewhere.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'unverified' })
    expect(await elsewhere.call('sendVerification')).toEqual({ ok: true })
    expect(mails.filter(mail => mail.kind === 'verify-email')).toHaveLength(2)
    expect(await elsewhere.call('verifyEmail', tokenOf('verify-email'))).toMatchObject({ ok: true })
    expect(await elsewhere.json('/me')).toBe('anonymous')
    expect(await elsewhere.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
  })

  test('with `requireVerified`, resending through a proved password is limited per account, and ends with the account', async () => {
    const { browser, mails } = setup({ requireVerified: true })
    const ada = browser()

    await browser().call('register', { email: 'ada@example.com', password: 'squatter password' })
    await ada.post('/password', { identifier: 'ada@example.com', password: 'squatter password' })

    const answers = [await ada.call('sendVerification'), await ada.call('sendVerification'), await ada.call('sendVerification'), await ada.call('sendVerification')]

    expect(answers.at(-1)).toEqual({ ok: false, error: 'limited' })

    // The address registered again replaces the account this browser proved the password of.
    await browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    const sent = mails.length

    expect(await ada.call('sendVerification')).toEqual({ ok: false, error: 'signed-out' })
    expect(mails).toHaveLength(sent)
  })

  test('with `requireVerified`, a browser that proved a password forgets it on signing out, and serves whoever is signed in first', async () => {
    const { browser, store } = setup({ requireVerified: true })
    const ada = browser()

    await browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.post('/password', { identifier: 'ada@example.com', password: PASSWORD })
    await ada.post('/sign-out', {})

    expect(await ada.call('sendVerification')).toEqual({ ok: false, error: 'signed-out' })

    await ada.post('/password', { identifier: 'ada@example.com', password: PASSWORD })
    await store.users.create(userRecord({ id: 'u2', email: 'bob@example.com', emailVerifiedAt: new Date() }))
    await ada.post('/sign-in/u2', {})

    expect(await ada.call('sendVerification')).toEqual({ ok: false, error: 'verified' })
  })
})

describe('resetting a password', () => {
  async function registered() {
    const app = setup()
    const ada = app.browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    return { ...app, ada }
  }

  test('mails a link when the address has an account, and answers alike when none does', async () => {
    const { browser, mails } = await registered()

    expect(await browser().call('requestPasswordReset', 'ADA@example.com')).toEqual({ ok: true })
    expect(await browser().call('requestPasswordReset', 'nobody@example.com')).toEqual({ ok: true })
    expect(mails.filter(mail => mail.kind === 'reset-password').map(mail => mail.to)).toEqual(['ada@example.com'])
  })

  test('sets the new password and signs in here', async () => {
    const { browser, tokenOf } = await registered()
    const reset = browser()

    await reset.call('requestPasswordReset', 'ada@example.com')

    expect(await reset.call('resetPassword', tokenOf('reset-password'), 'a brand new password')).toEqual({ ok: true, redirect: '/' })
    expect(await reset.json('/me')).toMatchObject({ email: 'ada@example.com', emailVerified: true })
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: 'a brand new password' })).toMatchObject({ ok: true })
  })

  test('a refused password leaves the link usable', async () => {
    const { browser, tokenOf } = await registered()
    const reset = browser()

    await reset.call('requestPasswordReset', 'ada@example.com')
    const token = tokenOf('reset-password')

    expect(await reset.call('resetPassword', token, 'short')).toEqual({ ok: false, errors: { password: 'too-short' } })
    expect(await reset.call('resetPassword', token, 'a brand new password')).toMatchObject({ ok: true })
  })

  test('limits how many mails one address is sent, and answers alike whether or not an account has it', async () => {
    const { browser, mails } = await registered()
    const answers = async (email: string) => {
      const all = []

      for (let index = 0; index < 4; index++)
        all.push(await browser().call('requestPasswordReset', email))

      return all
    }

    expect(await answers('ada@example.com')).toEqual(await answers('nobody@example.com'))
    expect(mails.filter(mail => mail.kind === 'reset-password')).toHaveLength(3)
  })
})

describe('magic links', () => {
  test('sign in once, where asked, and verify the address', async () => {
    const { browser, store, tokenOf } = setup()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    const ada = browser()

    expect(await ada.call('requestMagicLink', 'ada@example.com', { redirect: '/account' })).toEqual({ ok: true })

    const token = tokenOf('magic-link')

    expect(await ada.call('signInWithMagicLink', token)).toEqual({ ok: true, redirect: '/account' })
    expect(await ada.json('/me')).toMatchObject({ id: 'u1', emailVerified: true })
    expect(await browser().call('signInWithMagicLink', token)).toEqual({ ok: false, error: 'invalid' })
  })

  test('an account a stranger registered with the address goes to its owner clean, the stranger signed out and their password void', async () => {
    const { browser, tokenOf } = setup()
    const stranger = browser()

    await stranger.call('register', { email: 'ada@example.com', password: 'squatter password' })
    const minted = await stranger.callOk('createToken', { password: 'squatter password' }, 'stranger')
    const ada = browser()

    await ada.call('requestMagicLink', 'ada@example.com')
    await ada.call('signInWithMagicLink', tokenOf('magic-link'))

    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com', emailVerified: true, hasPassword: false, twoFactor: false })
    expect(await stranger.json('/me')).toBe('anonymous')
    expect(await browser().json('/me', { headers: { authorization: `Bearer ${minted.token}` } })).toBe('anonymous')
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: 'squatter password' })).toEqual({ ok: false, error: 'invalid' })
  })

  test('a passkey the stranger added before the owner claimed the account signs no one in after the claim', async () => {
    const { browser, tokenOf } = setup()
    const stranger = browser()
    const device = authenticator()

    await stranger.call('register', { email: 'ada@example.com', password: 'squatter password' })
    const { options } = await stranger.callOk('passkeyRegistrationOptions', { password: 'squatter password' })

    expect(await stranger.call('registerPasskey', await device.create(options))).toMatchObject({ ok: true })

    const ada = browser()

    await ada.call('requestPasswordReset', 'ada@example.com')
    await ada.call('resetPassword', tokenOf('reset-password'), 'owner password, at last')

    const signIn = await stranger.call('passkeySignInOptions')

    expect(await stranger.call('signInWithPasskey', await device.get(signIn))).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.call('listPasskeys')).toEqual([])
  })

  test('a link for an address the account has since left is spent for nothing', async () => {
    const { browser, store, tokenOf } = setup()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    await browser().call('requestMagicLink', 'ada@example.com')
    await store.users.update('u1', { email: 'ada@elsewhere.test' })

    expect(await browser().call('signInWithMagicLink', tokenOf('magic-link'))).toEqual({ ok: false, error: 'invalid' })
  })

  test('a token of one kind opens nothing of another', async () => {
    const { browser, store, tokenOf } = setup()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    await browser().call('requestPasswordReset', 'ada@example.com')

    expect(await browser().call('signInWithMagicLink', tokenOf('reset-password'))).toEqual({ ok: false, error: 'invalid' })
  })
})

describe('changing an email', () => {
  test('mails the new address and moves the account once confirmed', async () => {
    const { browser, mails, tokenOf } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('changeEmail', { password: PASSWORD }, 'ada@new.test')).toEqual({ ok: true })
    expect(mails.at(-1)).toMatchObject({ to: 'ada@new.test', kind: 'change-email' })
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })

    expect(await ada.call('confirmEmailChange', tokenOf('change-email'))).toEqual({ ok: true, redirect: '/' })
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@new.test', emailVerified: true })
  })

  test('refuses an address another account has, the same one, or a wrong password', async () => {
    const { browser, store } = setup()
    const ada = browser()

    await store.users.create(userRecord({ id: 'u2', email: 'bob@example.com' }))
    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('changeEmail', { password: PASSWORD }, 'BOB@example.com')).toEqual({ ok: false, errors: { email: 'taken' } })
    expect(await ada.call('changeEmail', { password: PASSWORD }, 'ada@example.com')).toEqual({ ok: false, errors: { email: 'unchanged' } })
    expect(await ada.call('changeEmail', { password: 'wrong password!' }, 'ada@new.test')).toEqual({ ok: false, error: 'proof' })
    expect(await browser().call('changeEmail', { password: PASSWORD }, 'x@example.com')).toEqual({ ok: false, error: 'signed-out' })
  })

  test('an address taken between the mail and the click is not moved to', async () => {
    const { browser, store, tokenOf } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.call('changeEmail', { password: PASSWORD }, 'ada@new.test')
    await store.users.create(userRecord({ id: 'u2', email: 'ada@new.test' }))

    expect(await ada.call('confirmEmailChange', tokenOf('change-email'))).toEqual({ ok: false, error: 'invalid' })
  })
})

test('an app without a mailer answers that mail is unavailable', async () => {
  const { browser, store } = testApp()

  await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))

  expect(await browser().call('requestPasswordReset', 'ada@example.com')).toEqual({ ok: false, error: 'unavailable' })
})
