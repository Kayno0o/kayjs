import type { Duration } from 'kay'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { testApp } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const DAY = 24 * 60 * 60

afterEach(() => {
  setSystemTime()
})

// The names a lifetime had before 1.70 keep working until 1.73, and the new name wins when both are given.
describe('lifetimes under their names before 1.70', () => {
  test('rememberMaxAge is remember.maxAge', async () => {
    for (const [options, expected] of [[{ rememberMaxAge: '45d' }, 45 * DAY], [{ rememberMaxAge: '45d', remember: { maxAge: '10d' } }, 10 * DAY]] as const) {
      const { browser, store } = testApp(options as never)
      const ada = browser()

      await ada.call('register', { email: 'ada@example.com', password: PASSWORD }, { remember: true })
      expect((await store.sessions.listByUser((await ada.json('/me') as { id: string }).id))[0]!.maxAge).toBe(expected)
    }
  })

  test('email.expires is email.maxAge', async () => {
    const { mailer, mails } = mailbox()
    const app = testApp({ url: 'https://site.test', site: 'Site', email: { mailer, links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }, requireVerified: false, expires: { 'reset-password': '2h' } } })
    const ada = app.browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.call('requestPasswordReset', 'ada@example.com')
    expect(mails.find(mail => mail.kind === 'reset-password')!.maxAge).toEqual({ link: 2 * 3600 })
    expect(mails.find(mail => mail.kind === 'reset-password')!.expires).toEqual({ link: 2 * 3600 })
  })

  test('email.expires and email.maxAge are merged key by key, the new one winning', async () => {
    const { mailer, mails } = mailbox()
    const app = testApp({ url: 'https://site.test', site: 'Site', email: { mailer, links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }, requireVerified: false, expires: { 'reset-password': '2h', 'verify-email': '3d' }, maxAge: { 'reset-password': '1h' } } })
    const ada = app.browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.call('requestPasswordReset', 'ada@example.com')
    expect(mails.find(mail => mail.kind === 'reset-password')!.maxAge).toEqual({ link: 3600 })
    expect(mails.find(mail => mail.kind === 'verify-email')!.maxAge).toEqual({ link: 3 * DAY })
  })

  test('a token\'s maxAge wins over expiresIn, and null never expires', async () => {
    const { browser, store } = testApp({ scopes: ['posts:read'] })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.callOk('createToken', { password: PASSWORD }, 'Phone', { maxAge: '1d', expiresIn: '30d' })
    await ada.callOk('createToken', { password: PASSWORD }, 'Forever', { maxAge: null, expiresIn: '30d' })

    const tokens = await store.bearerTokens.listByUser((await ada.json('/me') as { id: string }).id)
    const phone = tokens.find(token => token.label === 'Phone')!

    expect(phone.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(DAY * 1000)
    expect(tokens.find(token => token.label === 'Forever')!.expiresAt).toBeNull()
  })

  test('a token\'s expiresIn is maxAge', async () => {
    const { browser, store } = testApp({ scopes: ['posts:read'] })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    await ada.callOk('createToken', { password: PASSWORD }, 'Phone', { expiresIn: '30d' })
    expect(await ada.call('createToken', { password: PASSWORD }, 'Tablet', { expiresIn: 'forever' as Duration })).toEqual({ ok: false, error: 'expiry' })

    const [stored] = await store.bearerTokens.listByUser((await ada.json('/me') as { id: string }).id)

    expect(stored!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(30 * DAY * 1000 - 60_000)
  })
})
