import type { CodeMode } from '../src/email'
import type { AuthMailMessage as Mail } from '../src/mail'
import { describe, expect, test } from 'bun:test'
import { totpCode, totpStep } from '../src/totp'
import { testApp } from './helpers/app'
import { mailbox } from './helpers/mail'

// Deep links survive the sign-in: the page a visitor asked for is kept by every way that leads back to the sign-in page, and reached once they are in.
const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const HOSTILE = ['//evil.test', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)']

function setup(options: { requireVerified?: boolean, codes?: CodeMode } = {}) {
  const { mails, mailer, take } = mailbox()
  const app = testApp({ url: 'https://site.test/', site: 'Site', signInPage: '/login', email: { mailer, links: LINKS, requireVerified: options.requireVerified ?? false, codes: options.codes } })
  const tokenOf = (kind: Mail['kind']) => new URL(mails.findLast(mail => mail.kind === kind)!.url!).searchParams.get('token')!
  const codeOf = (kind: Mail['kind']) => mails.findLast(mail => mail.kind === kind)!.code!

  return { ...app, mails, take, tokenOf, codeOf }
}

describe('registering', () => {
  test('a signed-in registration verifies the address and goes on to the page the visitor asked for', async () => {
    const { browser, tokenOf } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD }, { redirect: '/members?tab=2' })

    expect(await ada.call('verifyEmail', tokenOf('verify-email'))).toEqual({ ok: true, redirect: '/members?tab=2' })
  })

  test('with `requireVerified`, the browser that registered goes to the sign-in page, carrying the page', async () => {
    const { browser, tokenOf } = setup({ requireVerified: true })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD }, { redirect: '/members?tab=2' })

    expect(await ada.call('verifyEmail', tokenOf('verify-email'))).toEqual({ ok: true, redirect: '/login?redirect=%2Fmembers%3Ftab%3D2' })
  })

  test('another browser opening the mail, given the password, is sent the same way', async () => {
    const { browser, tokenOf } = setup({ requireVerified: true })

    await browser().call('register', { email: 'ada@example.com', password: PASSWORD }, { redirect: '/members' })

    expect(await browser().call('verifyEmail', tokenOf('verify-email'), PASSWORD)).toEqual({ ok: true, redirect: '/login?redirect=%2Fmembers' })
  })

  test('with codes, the code verifies and leads on as the link does', async () => {
    const { browser, codeOf } = setup({ requireVerified: true, codes: 'code' })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD }, { redirect: '/members' })

    expect(await ada.call('verifyEmailCode', codeOf('verify-email'))).toEqual({ ok: true, redirect: '/login?redirect=%2Fmembers' })
  })

  test('a resend keeps the page', async () => {
    const { browser, tokenOf } = setup({ requireVerified: true })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD }, { redirect: '/members' })
    expect(await ada.call('sendVerification')).toEqual({ ok: true })

    expect(await ada.call('verifyEmail', tokenOf('verify-email'))).toEqual({ ok: true, redirect: '/login?redirect=%2Fmembers' })
  })

  test('a password sign-in refused as unverified keeps the page for the resend', async () => {
    const { browser, tokenOf } = setup({ requireVerified: true })

    await browser().call('register', { email: 'ada@example.com', password: PASSWORD })

    const again = browser()

    expect(await again.post('/password', { identifier: 'ada@example.com', password: PASSWORD, redirect: '/members' })).toEqual({ ok: false, error: 'unverified' })
    expect(await again.call('sendVerification')).toEqual({ ok: true })
    expect(await again.call('verifyEmail', tokenOf('verify-email'))).toEqual({ ok: true, redirect: '/login?redirect=%2Fmembers' })
  })

  test('a registration with no page, or one that leaves the site, leads to the sign-in page, or home, as before', async () => {
    const { browser, tokenOf } = setup({ requireVerified: true })

    await browser().call('register', { email: 'plain@example.com', password: PASSWORD })
    expect(await browser().call('verifyEmail', tokenOf('verify-email'), PASSWORD)).toEqual({ ok: true, redirect: '/login' })

    for (const [index, hostile] of HOSTILE.entries()) {
      const email = `hostile${index}@example.com`

      await browser().call('register', { email, password: PASSWORD }, { redirect: hostile })
      expect(await browser().call('verifyEmail', tokenOf('verify-email'), PASSWORD)).toEqual({ ok: true, redirect: '/login' })
    }

    const signedIn = setup()
    const grace = signedIn.browser()

    await grace.call('register', { email: 'grace@example.com', password: PASSWORD }, { redirect: '//evil.test' })
    expect(await grace.call('verifyEmail', signedIn.tokenOf('verify-email'))).toEqual({ ok: true, redirect: '/' })
  })
})

describe('a forgotten password', () => {
  test('the reset signs in to the page the visitor asked for', async () => {
    const { browser, take, tokenOf } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.post('/sign-out', {})

    const forgetful = browser()

    await forgetful.call('requestPasswordReset', 'ada@example.com', { redirect: '/members?tab=2' })
    await take({ kind: 'reset-password' })
    expect(await forgetful.call('resetPassword', tokenOf('reset-password'), 'a brand new passphrase')).toEqual({ ok: true, redirect: '/members?tab=2' })
  })

  test('a page that leaves the site leads home', async () => {
    const { browser, take, tokenOf } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.post('/sign-out', {})

    for (const hostile of HOSTILE.slice(0, 2)) {
      await ada.call('requestPasswordReset', 'ada@example.com', { redirect: hostile })
      await take({ kind: 'reset-password' })
      expect(await ada.call('resetPassword', tokenOf('reset-password'), `a brand new passphrase ${hostile.length}`)).toEqual({ ok: true, redirect: '/' })
      await ada.post('/sign-out', {})
    }
  })
})

describe('the second factor', () => {
  test('a password sign-in asked for a page carries it to the code page, and the code leads on to it', async () => {
    const { browser } = testApp({ site: 'Site' })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    const setup = await ada.callOk('setUpTwoFactor', { password: PASSWORD })
    const secret = setup.setup.secret

    await ada.callOk('enableTwoFactor', await totpCode(secret, totpStep()))
    await ada.post('/sign-out', {})

    expect(await ada.post('/password', { identifier: 'ada@example.com', password: PASSWORD, redirect: '/members?tab=2' })).toEqual({ ok: true, redirect: '/two-factor?redirect=%2Fmembers%3Ftab%3D2' })
    expect(await ada.call('verifyTwoFactor', await totpCode(secret, totpStep() + 1))).toEqual({ ok: true, redirect: '/members?tab=2' })
  })

  test('with no page asked for, the code page is as bare as before', async () => {
    const { browser } = testApp({ site: 'Site' })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    const setup = await ada.callOk('setUpTwoFactor', { password: PASSWORD })

    await ada.callOk('enableTwoFactor', await totpCode(setup.setup.secret, totpStep()))
    await ada.post('/sign-out', {})

    expect(await ada.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: true, redirect: '/two-factor' })
  })
})
