import type { Duration } from 'kay'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { lifetime } from '../src/mail'
import { testApp, userRecord } from './helpers/app'
import { mailbox } from './helpers/mail'

const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const PASSWORD = 'correct horse battery'

afterEach(() => {
  setSystemTime()
})

function setup(email: { maxAge?: Partial<Record<'verify-email' | 'reset-password' | 'magic-link' | 'change-email' | 'sign-in-code' | 'verify-code', Duration>>, codes?: 'both' | 'code' } = {}, locales?: string[]) {
  const { mails, mailer } = mailbox()
  const app = testApp({ url: 'https://site.test', site: 'Site', email: { mailer, links: LINKS, requireVerified: false, ...email, ...locales && { locales } } })

  return { ...app, mails }
}

const tokenOf = (mail: { url?: string | undefined }) => new URL(mail.url!).searchParams.get('token')!

describe('lifetime words', () => {
  test('uses the largest unit that fills the time, in the language', () => {
    expect([lifetime(86_400, 'en'), lifetime(7 * 86_400, 'en'), lifetime(3600, 'en'), lifetime(90 * 60, 'en'), lifetime(900, 'en'), lifetime(45, 'en')]).toEqual(['24 hours', '7 days', '1 hour', '90 minutes', '15 minutes', '45 seconds'])
    expect([lifetime(86_400, 'fr'), lifetime(3600, 'fr'), lifetime(600, 'fr')].map(words => words.replace(/\s/g, ' '))).toEqual(['24 heures', '1 heure', '10 minutes'])
    expect(lifetime(600, 'not a locale')).toBe('10 minutes')
  })
})

describe('email.expires', () => {
  test('the defaults hold and the mails state them', async () => {
    const { browser, mails } = setup({ codes: 'both' })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.call('requestPasswordReset', 'ada@example.com')

    const verify = mails.find(mail => mail.kind === 'verify-email')!
    const reset = mails.find(mail => mail.kind === 'reset-password')!

    expect(verify.text).toContain('The link works for 24 hours. The code works for 10 minutes')
    expect(verify.html).toContain('The link works for 24 hours.')
    expect(reset.text).toContain('The link works for 1 hour.')
  })

  test('sets each link and code, the mails state the real figure in every kind and language, and the template data carries seconds', async () => {
    const seen: unknown[] = []
    const { mailer, mails } = mailbox()
    const { browser, store } = testApp({
      url: 'https://site.test',
      site: 'Site',
      email: {
        mailer,
        links: LINKS,
        requireVerified: false,
        locales: ['en', 'fr'],
        codes: 'both',
        maxAge: { 'verify-email': '7d', 'reset-password': '30m', 'magic-link': '2h', 'change-email': '3h', 'verify-code': '20m', 'sign-in-code': '5m' },
        templates: { 'reset-password': (data) => {
          seen.push(data.expires)

          return { subject: 's', text: 't', html: 'h' }
        } },
      },
    })

    await store.users.create(userRecord({ id: 'u1', email: 'fr@example.com', emailVerifiedAt: new Date(), locale: 'fr' }))

    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.call('requestMagicLink', 'ada@example.com')
    await ada.call('requestMagicLink', 'fr@example.com')
    await ada.call('requestPasswordReset', 'ada@example.com')
    await ada.call('changeEmail', { password: PASSWORD }, 'new@example.com')

    const of = (kind: string, to?: string) => ({ text: mails.find(mail => mail.kind === kind && (to === undefined || mail.to === to))!.text.replace(/\s/g, ' ') })

    expect(of('verify-email').text).toContain('The link works for 7 days. The code works for 20 minutes')
    expect(of('magic-link', 'ada@example.com').text).toContain('The link works for 2 hours, once. The code works for 5 minutes')
    expect(of('magic-link', 'fr@example.com').text).toContain('Le lien est valable 2 heures, une seule fois. Le code est valable 5 minutes')
    expect(of('change-email').text).toContain('The link works for 3 hours.')
    expect(seen).toEqual([{ link: 1800 }])
  })

  test('a reset link lives its set time and no longer', async () => {
    const { browser, mails } = setup({ maxAge: { 'reset-password': '2h' } })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.call('requestPasswordReset', 'ada@example.com')

    const token = tokenOf(mails.find(mail => mail.kind === 'reset-password')!)

    setSystemTime(new Date(Date.now() + 121 * 60 * 1000))
    expect(await ada.call('resetPassword', token, 'a brand new password')).toEqual({ ok: false, error: 'invalid' })
    setSystemTime()
    await ada.call('requestPasswordReset', 'ada@example.com')
    setSystemTime(new Date(Date.now() + 90 * 60 * 1000))
    expect(await ada.call('resetPassword', tokenOf(mails.findLast(mail => mail.kind === 'reset-password')!), 'a brand new password')).toMatchObject({ ok: true })
  })

  test('a verification link set to a week still works after the default day, and a code after its own time', async () => {
    const { browser, mails } = setup({ maxAge: { 'verify-email': '7d', 'verify-code': '1h' }, codes: 'both' })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    const mail = mails.find(mail => mail.kind === 'verify-email')!

    setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000))
    expect(await ada.call('verifyEmailCode', mail.code!)).toEqual({ ok: false, error: 'expired' })
    setSystemTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000))
    expect(await ada.call('verifyEmail', tokenOf(mail))).toMatchObject({ ok: true })
  })

  test('a bad lifetime fails at boot naming it', () => {
    expect(() => setup({ maxAge: { 'verify-email': 'a week' as Duration } })).toThrow('kay: email.maxAge.verify-email is \'a week\'')
    expect(() => setup({ maxAge: { verify: '1d' } as never })).toThrow('kay: email.maxAge.verify is no link or code')
    expect(() => setup({ maxAge: { constructor: '1d' } as never })).toThrow('kay: email.maxAge.constructor is no link or code')
    expect(() => setup({ maxAge: { 'magic-link': '0s' } })).toThrow('kay: email.maxAge.magic-link is \'0s\'')
  })
})
