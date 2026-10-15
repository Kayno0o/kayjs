import type { CodedLink, CodeMode } from '../src/email'
import type { Limits } from '../src/limits'
import type { MailKind } from '../src/mail'
import { describe, expect, test } from 'bun:test'
import { testApp, userRecord } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const CODE = /\b(\d{6})\b/

async function setup(codes: CodeMode | Partial<Record<CodedLink, CodeMode>>, limits: Partial<Limits> = {}) {
  const { mails, mailer, take } = mailbox()
  const app = testApp({
    url: 'https://site.test',
    site: 'Site',
    limits,
    email: {
      mailer,
      links: LINKS,
      codes,
    },
  })

  await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))

  const nextMail = async (kind: MailKind) => (await take({ kind }))[0]!

  return { ...app, mails, nextMail }
}

describe('emailed codes', () => {
  test('a sign-in mail carries a code instead of a link, and the code signs in where it was asked for, once', async () => {
    const { browser, nextMail } = await setup({ 'magic-link': 'code' })
    const ada = browser()

    expect(await ada.call('requestMagicLink', 'ada@example.com', '/account')).toEqual({ ok: true })

    const mail = await nextMail('magic-link')

    expect(mail.url).toBeUndefined()
    expect(mail.code).toMatch(/^\d{6}$/)
    expect(mail.text).toContain(`Your code: ${mail.code}`)
    expect(mail.html).toContain(mail.code!)
    expect(await ada.call('emailCodePending')).toEqual({ type: 'sign-in', email: 'ada@example.com' })
    expect(await browser().call('signInWithEmailCode', mail.code)).toEqual({ ok: false, error: 'expired' })
    expect(await ada.call('signInWithEmailCode', `${mail.code!.slice(0, 3)} ${mail.code!.slice(3)}`)).toEqual({ ok: true, redirect: '/account' })
    expect(await ada.json('/me')).toMatchObject({ id: 'u1' })
    expect(await ada.call('emailCodePending')).toBeFalsy()
    expect(await ada.call('signInWithEmailCode', mail.code)).toEqual({ ok: false, error: 'expired' })
  })

  test('a code works only in the session that asked for it, even one waiting for its own', async () => {
    const { browser, nextMail } = await setup('code')
    const ada = browser()
    const thief = browser()

    await ada.call('requestMagicLink', 'ada@example.com')
    const first = await nextMail('magic-link')

    await thief.call('requestMagicLink', 'ada@example.com')
    const second = await nextMail('magic-link')

    expect(await thief.call('signInWithEmailCode', first.code)).toEqual({ ok: false, error: 'invalid' })
    // A new code voids the last one.
    expect(await ada.call('signInWithEmailCode', first.code)).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.call('signInWithEmailCode', second.code)).toEqual({ ok: false, error: 'invalid' })
  })

  test('with both, the mail carries the link and the code, and spending one spends the other', async () => {
    const { browser, nextMail } = await setup('both')
    const ada = browser()

    await ada.call('requestMagicLink', 'ada@example.com')
    const mail = await nextMail('magic-link')

    expect(mail.url).toStartWith('https://site.test/magic?token=')
    expect(mail.text).toContain(`Or type this code where you asked for it: ${mail.code}`)
    expect(await ada.call('signInWithEmailCode', mail.code)).toMatchObject({ ok: true })
    expect(await browser().call('signInWithMagicLink', new URL(mail.url!).searchParams.get('token'))).toEqual({ ok: false, error: 'invalid' })

    await ada.call('requestMagicLink', 'ada@example.com')
    const next = await nextMail('magic-link')

    expect(await browser().call('signInWithMagicLink', new URL(next.url!).searchParams.get('token'))).toMatchObject({ ok: true })
    expect(await ada.call('signInWithEmailCode', next.code)).toEqual({ ok: false, error: 'invalid' })
  })

  test('a code dies after five misses, the right one included', async () => {
    const { browser, nextMail } = await setup('code')
    const ada = browser()

    await ada.call('requestMagicLink', 'ada@example.com')
    const { code } = await nextMail('magic-link')
    const wrong = code === '000000' ? '111111' : '000000'

    for (let miss = 1; miss < 5; miss++)
      expect(await ada.call('signInWithEmailCode', wrong)).toEqual({ ok: false, error: 'invalid' })

    expect(await ada.call('signInWithEmailCode', wrong)).toEqual({ ok: false, error: 'expired' })
    expect(await ada.call('signInWithEmailCode', code)).toEqual({ ok: false, error: 'expired' })
  })

  test('guesses are limited per address, across codes and clients', async () => {
    const { browser, nextMail } = await setup('code', { emailCodeAccount: { max: 2, window: 900 } })
    const ada = browser()

    await ada.call('requestMagicLink', 'ada@example.com')
    const { code } = await nextMail('magic-link')
    const wrong = code === '000000' ? '111111' : '000000'

    expect(await ada.call('signInWithEmailCode', wrong)).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.call('signInWithEmailCode', wrong)).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.call('signInWithEmailCode', code)).toEqual({ ok: false, error: 'limited' })
  })

  test('two requests spending one code together sign in once', async () => {
    const { browser, nextMail } = await setup('code')
    const ada = browser()

    await ada.call('requestMagicLink', 'ada@example.com')
    const { code } = await nextMail('magic-link')
    const results = await Promise.all([ada.call('signInWithEmailCode', code), ada.call('signInWithEmailCode', code)])

    expect(results.filter(result => result.ok === true)).toHaveLength(1)
  })

  test('an address with no account waits for a code like any other, which never comes', async () => {
    const { browser, mails } = await setup('code')
    const bob = browser()

    expect(await bob.call('requestMagicLink', 'bob@example.com')).toEqual({ ok: true })
    expect(await bob.call('emailCodePending')).toEqual({ type: 'sign-in', email: 'bob@example.com' })
    expect(await bob.call('signInWithEmailCode', '123456')).toEqual({ ok: false, error: 'invalid' })
    expect(mails).toEqual([])
  })

  test('verification mails carry a code that verifies the address in the browser that registered', async () => {
    const { browser, nextMail, store } = await setup({ 'verify-email': 'code' })
    const bob = browser()

    await bob.post('/register', { email: 'bob@example.com', password: PASSWORD })
    const mail = await nextMail('verify-email')

    expect(mail.url).toBeUndefined()
    expect(await bob.call('emailCodePending')).toEqual({ type: 'verify', email: 'bob@example.com' })
    expect(await bob.call('signInWithEmailCode', mail.code)).toEqual({ ok: false, error: 'expired' })
    expect(await bob.call('verifyEmailCode', mail.code)).toEqual({ ok: true, redirect: '/' })
    expect((await store.users.findByEmail('bob@example.com'))?.emailVerifiedAt).toBeInstanceOf(Date)

    await bob.call('requestMagicLink', 'ada@example.com')

    // Magic links stayed links.
    expect((await nextMail('magic-link')).code).toBeUndefined()
  })

  test('a resent verification mail carries a new code', async () => {
    const { browser, nextMail } = await setup({ 'verify-email': 'both' })
    const bob = browser()

    await bob.post('/register', { email: 'bob@example.com', password: PASSWORD })
    const first = await nextMail('verify-email')

    await bob.call('sendVerification')
    const second = await nextMail('verify-email')

    expect(CODE.exec(second.text)?.[1]).toBe(second.code)
    expect(await bob.call('verifyEmailCode', first.code)).toEqual({ ok: false, error: 'invalid' })
    expect(await bob.call('verifyEmailCode', second.code)).toEqual({ ok: true, redirect: '/' })
  })
})
