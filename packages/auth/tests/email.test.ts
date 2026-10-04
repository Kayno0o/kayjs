import type { Mail } from '../src/mail'
import { describe, expect, test } from 'bun:test'
import { testApp, userRecord } from './helpers/app'

const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }

function setup(options: { requireVerified?: boolean } = {}) {
  const mails: Mail[] = []
  const app = testApp({
    url: 'https://site.test/',
    site: 'Site',
    email: {
      mailer: {
        send: (mail) => {
          mails.push(mail)
        },
      },
      links: LINKS,
      requireVerified: options.requireVerified,
    },
  })

  // The token the last mail of that kind carries.
  const tokenOf = (kind: Mail['kind']) => new URL(mails.findLast(mail => mail.kind === kind)!.url!).searchParams.get('token')!

  return { ...app, mails, tokenOf }
}

describe('verifying an email', () => {
  test('registering mails a link to the app\'s page, and spending it verifies the address', async () => {
    const { browser, mails, tokenOf } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(mails).toHaveLength(1)
    expect(mails[0]).toMatchObject({ to: 'ada@example.com', kind: 'verify-email', subject: 'Confirm your email for Site' })
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

  test('opening the link in another browser signs the user in there', async () => {
    const { browser, tokenOf } = setup()

    await browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    const elsewhere = browser()

    await elsewhere.call('verifyEmail', tokenOf('verify-email'))

    expect(await elsewhere.json('/me')).toMatchObject({ email: 'ada@example.com', emailVerified: true })
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
    expect(await browser().call('register', { email: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })

    const ada = browser()

    await ada.call('verifyEmail', tokenOf('verify-email'))

    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: 'squatter password' })).toEqual({ ok: false, error: 'invalid' })
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

  test('sets the new password, ends every other session, and signs in here', async () => {
    const { browser, ada, tokenOf } = await registered()
    const reset = browser()

    await reset.call('requestPasswordReset', 'ada@example.com')

    expect(await reset.call('resetPassword', tokenOf('reset-password'), 'a brand new password')).toEqual({ ok: true, redirect: '/' })
    expect(await reset.json('/me')).toMatchObject({ email: 'ada@example.com', emailVerified: true })
    expect(await ada.json('/me')).toBe('anonymous')
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

  test('limits how many mails one account is sent', async () => {
    const { browser, mails } = await registered()

    for (let index = 0; index < 4; index++)
      await browser().call('requestPasswordReset', 'ada@example.com')

    expect(mails.filter(mail => mail.kind === 'reset-password')).toHaveLength(3)
  })
})

describe('magic links', () => {
  test('sign in once, where asked, and verify the address', async () => {
    const { browser, store, tokenOf } = setup()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    const ada = browser()

    expect(await ada.call('requestMagicLink', 'ada@example.com', '/account')).toEqual({ ok: true })

    const token = tokenOf('magic-link')

    expect(await ada.call('signInWithMagicLink', token)).toEqual({ ok: true, redirect: '/account' })
    expect(await ada.json('/me')).toMatchObject({ id: 'u1', emailVerified: true })
    expect(await browser().call('signInWithMagicLink', token)).toEqual({ ok: false, error: 'invalid' })
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
  test('mails the new address and moves the account once confirmed, ending the other sessions', async () => {
    const { browser, mails, tokenOf } = setup()
    const ada = browser()
    const elsewhere = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await elsewhere.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('changeEmail', { password: PASSWORD }, 'ada@new.test')).toEqual({ ok: true })
    expect(mails.at(-1)).toMatchObject({ to: 'ada@new.test', kind: 'change-email' })
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })

    expect(await ada.call('confirmEmailChange', tokenOf('change-email'))).toEqual({ ok: true, redirect: '/' })
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@new.test', emailVerified: true })
    expect(await elsewhere.json('/me')).toBe('anonymous')
  })

  test('refuses an address another account has, or the same one', async () => {
    const { browser, store } = setup()
    const ada = browser()

    await store.users.create(userRecord({ id: 'u2', email: 'bob@example.com' }))
    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('changeEmail', { password: PASSWORD }, 'BOB@example.com')).toEqual({ ok: false, errors: { email: 'taken' } })
    expect(await ada.call('changeEmail', { password: PASSWORD }, 'ada@example.com')).toEqual({ ok: false, errors: { email: 'unchanged' } })
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
