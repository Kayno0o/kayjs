import type { RememberMode } from '../src/pages'
import { afterEach, describe, expect, test } from 'bun:test'
import { discordProvider } from '../src/oauth/providers'
import { testApp, userRecord } from './helpers/app'
import { authenticator } from './helpers/authenticator'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const HOME = '/dashboard'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function setup(options: { home?: string | undefined, pages?: boolean, requireVerified?: boolean, codes?: 'code' } = {}) {
  const { mails, mailer, take } = mailbox()
  const pages = options.pages === false ? undefined : { home: options.home ?? '/' }
  const app = testApp({
    url: 'https://site.test',
    pages,
    signInPage: '/login',
    oauth: { discord: { provider: discordProvider(), clientId: 'id', clientSecret: 'secret' } },
    email: { mailer, links: LINKS, requireVerified: options.requireVerified ?? false, codes: options.codes && { 'magic-link': options.codes } },
  })
  const tokenOf = (kind: string) => new URL(mails.findLast(mail => mail.kind === kind)!.url!).searchParams.get('token')!

  return { ...app, mails, take, tokenOf }
}

describe('where a flow lands when nothing asked for another page', () => {
  test('is pages.home for a reset, a verification, an email change, a magic link, a code, a password and a register', async () => {
    const { browser, tokenOf, take } = setup({ home: HOME })
    const ada = browser()
    const registered = await ada.callOk('register', { email: 'ada@example.com', password: PASSWORD })

    expect(registered).toMatchObject({ ok: true })
    expect(await ada.call('verifyEmail', tokenOf('verify-email'))).toEqual({ ok: true, redirect: HOME })

    await ada.call('changeEmail', { password: PASSWORD }, 'ada@new.test')
    expect(await ada.call('confirmEmailChange', tokenOf('change-email'))).toEqual({ ok: true, redirect: HOME })

    const reset = browser()

    await reset.call('requestPasswordReset', 'ada@new.test')
    await take({ kind: 'reset-password' })
    expect(await reset.call('resetPassword', tokenOf('reset-password'), 'a brand new password')).toEqual({ ok: true, redirect: HOME })

    const magic = browser()

    await magic.call('requestMagicLink', 'ada@new.test')
    await take({ kind: 'magic-link' })
    expect(await magic.call('signInWithMagicLink', tokenOf('magic-link'))).toEqual({ ok: true, redirect: HOME })
    expect(await browser().call('signInWithPassword', { identifier: 'ada@new.test', password: 'a brand new password' })).toEqual({ ok: true, redirect: HOME })
  })

  test('a verification in a browser not signed in goes to the sign-in page, and a code signs in to home', async () => {
    const { browser, tokenOf, take } = setup({ home: HOME, requireVerified: true, codes: 'code' })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await take({ kind: 'verify-email' })
    expect(await ada.call('verifyEmail', tokenOf('verify-email'))).toMatchObject({ ok: true })

    await ada.call('requestMagicLink', 'ada@example.com')

    const [mail] = await take({ kind: 'magic-link' })

    expect(await ada.call('signInWithEmailCode', mail!.code!)).toEqual({ ok: true, redirect: HOME })
  })

  test('a redirect asked for wins, and without pages the fallback stays /', async () => {
    const { browser, tokenOf, take } = setup({ pages: false })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    expect(await ada.call('verifyEmail', tokenOf('verify-email'))).toEqual({ ok: true, redirect: '/' })

    await ada.call('requestMagicLink', 'ada@example.com', { redirect: '/account' })
    await take({ kind: 'magic-link' })
    expect(await ada.call('signInWithMagicLink', tokenOf('magic-link'))).toEqual({ ok: true, redirect: '/account' })
    expect(await browser().call('signInWithPassword', { identifier: 'ada@example.com', password: PASSWORD, redirect: '//evil.test' })).toEqual({ ok: true, redirect: '/' })
  })

  test('a passkey sign-in and an OAuth sign-in land on home', async () => {
    const { browser } = setup({ home: HOME })
    const ada = browser()
    const device = authenticator()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    const { options } = await ada.callOk('passkeyRegistrationOptions', { password: PASSWORD })

    await ada.callOk('registerPasskey', await device.create(options))

    const visitor = browser()

    expect(await visitor.call('signInWithPasskey', await device.get(await visitor.call('passkeySignInOptions')))).toEqual({ ok: true, redirect: HOME })

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)

      return url.endsWith('/oauth2/token') ? Response.json({ access_token: 't', expires_in: 3600 }) : Response.json({ id: '9', username: 'grace', email: 'grace@example.com', verified: true })
    }) as typeof fetch

    const oauth = browser()
    const state = new URL((await oauth.fetch('/auth/discord')).headers.get('location')!).searchParams.get('state')!

    expect((await oauth.fetch(`/auth/discord/callback?code=c&state=${state}`)).headers.get('location')).toBe(HOME)
  })
})

describe('the pages option remember', () => {
  test('is a checkbox by default, and features tell the pages', async () => {
    const modes: (RememberMode | undefined)[] = [undefined, 'always', 'never']

    for (const remember of modes) {
      const { browser } = testApp({ url: 'https://site.test', pages: { remember } })

      expect(await browser().call('features')).toMatchObject({ pages: { prefix: '/auth', home: '/', remember: remember ?? 'checkbox' } })
    }
  })
})

describe('what the pages make of the box', () => {
  test('the checkbox decides, always keeps and never drops, whatever was posted', async () => {
    const { remembered } = await import('../src/pages/forms')
    const features = (remember: RememberMode) => ({ pages: { prefix: '/auth', home: '/', remember } })

    expect([true, false, undefined].map(chosen => remembered(features('checkbox'), chosen))).toEqual([true, false, false])
    expect([true, false, undefined].map(chosen => remembered(features('always'), chosen))).toEqual([true, true, true])
    expect([true, false, undefined].map(chosen => remembered(features('never'), chosen))).toEqual([false, false, false])
  })
})

describe('the lifetime of a sign-in by emailed code', () => {
  test('lasts a day when remember is false, rememberMaxAge when true, and the session plugin\'s maxAge when the sign-in said nothing', async () => {
    const { browser, take, store } = setup({ codes: 'code' })

    const DAY = 24 * 60 * 60

    for (const [index, [remember, expected]] of ([[false, DAY], [true, 90 * DAY], [undefined, 30 * DAY]] as const).entries()) {
      const email = `ada${index}@example.com`
      const visitor = browser()

      await store.users.create(userRecord({ id: `u${index}`, email, emailVerifiedAt: new Date() }))

      await visitor.call('requestMagicLink', email, remember === undefined ? {} : { remember })

      const [mail] = await take({ kind: 'magic-link' })

      expect(await visitor.call('signInWithEmailCode', mail!.code!)).toMatchObject({ ok: true })

      const [session] = await store.sessions.listByUser(`u${index}`)

      expect(session!.maxAge).toBe(expected === 30 * DAY ? null : expected)
    }
  })
})
