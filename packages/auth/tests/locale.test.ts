import type { EmailOptions } from '../src/email'
import { describe, expect, test } from 'bun:test'
import { flattenMessages, translate } from '../../../src/runtime/i18n'
import { acceptedLocales, pickLocale } from '../src/locale'
import french from '../src/messages/fr'
import { testApp } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }

function setup(email: Partial<EmailOptions> = {}) {
  const { mails, mailer, take } = mailbox()
  const app = testApp({
    url: 'https://site.test',
    site: 'Site',
    email: {
      mailer,
      links: LINKS,
      requireVerified: false,
      ...email,
    },
  })

  return { ...app, mails, take }
}

// Calls `auth[method](...args)` from a browser asking for `languages`.
function speaking(languages: string, ...args: unknown[]) {
  return { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': languages }, body: JSON.stringify(args) }
}

describe('locales', () => {
  test('an Accept-Language header reads most wanted first, and a tag picks its own locale, else its language\'s, else the first', () => {
    expect(acceptedLocales('fr-CA;q=0.8, en;q=0.5, de, *;q=0.1, xx_bad, it;q=0')).toEqual(['de', 'fr-CA', 'en'])
    expect(acceptedLocales('')).toEqual([])
    expect(pickLocale(['en', 'fr'], ['fr-CA', 'en'])).toBe('fr')
    expect(pickLocale(['en', 'pt-BR'], ['PT'])).toBe('pt-BR')
    expect(pickLocale(['en', 'fr'], [null, 'de'])).toBe('en')
  })

  test('a user registering keeps the browser\'s language, and mails speak it when the site does', async () => {
    const { browser, mails, store } = setup({ locales: ['en', 'fr'] })
    const { user } = await browser().json('/call/register', speaking('fr-FR,fr;q=0.9,en;q=0.5', { email: 'ada@example.com', password: PASSWORD })) as { user: { id: string } }

    expect((await store.users.get(user.id))!.locale).toBe('fr-FR')
    expect(mails[0]).toMatchObject({ kind: 'verify-email', locale: 'fr', subject: 'Confirmez votre adresse pour Site' })
    expect(mails[0]!.html).toContain('lang="fr"')
  })

  test('an English-only site writes English whatever the user reads', async () => {
    const { browser, mails } = setup()

    await browser().json('/call/register', speaking('fr', { email: 'ada@example.com', password: PASSWORD }))

    expect(mails[0]).toMatchObject({ locale: 'en', subject: 'Confirm your email for Site' })
  })

  test('the locale given on registering wins, setLocale changes it, and a user with none is written to in the browser\'s', async () => {
    const { browser, mails, store, take } = setup({ locales: ['en', 'fr'] })
    const ada = browser()
    const { user } = await ada.json('/call/register', speaking('en', { email: 'ada@example.com', password: PASSWORD, locale: 'fr' })) as { user: { id: string } }

    expect(mails.at(-1)!.locale).toBe('fr')
    expect(await ada.call('updateLocale', 'not a tag')).toEqual({ ok: false, error: 'invalid-locale' })
    expect(await ada.call('updateLocale', 'en-GB')).toEqual({ ok: true })
    expect(await ada.call('setLocale', 'not a tag')).toBe(false)
    expect(await ada.json('/me')).toMatchObject({ locale: 'en-GB' })

    await ada.call('requestPasswordReset', 'ada@example.com')

    expect((await take({ kind: 'reset-password' }))[0]).toMatchObject({ locale: 'en' })

    await store.users.update(user.id, { locale: null })
    await browser().json('/call/requestPasswordReset', speaking('fr-BE', 'ada@example.com'))

    expect((await take({ kind: 'reset-password' }))[0]).toMatchObject({ locale: 'fr', subject: 'Réinitialisez votre mot de passe Site' })
  })

  test('the app\'s templates go over every language, and a translation over them for its own', async () => {
    const { browser, mails, take } = setup({
      locales: ['en', 'de'],
      templates: { 'magic-link': data => ({ subject: `magic ${data.locale}`, text: '', html: '' }) },
      translations: { de: { 'verify-email': data => ({ subject: `Bestätigen ${data.site}`, text: '', html: '' }) } },
    })

    await browser().json('/call/register', speaking('de-AT', { email: 'ada@example.com', password: PASSWORD }))
    await browser().json('/call/requestMagicLink', speaking('de', 'ada@example.com'))
    await take({ kind: 'magic-link' })

    expect(mails.map(mail => [mail.kind, mail.locale, mail.subject])).toEqual([['verify-email', 'de', 'Bestätigen Site'], ['magic-link', 'de', 'magic de']])
  })
})

describe('the French wording', () => {
  const fr = { locale: 'fr', messages: flattenMessages(french) }

  test('a count picks the plural form of the recovery codes left and of the days a token lasts', () => {
    const codes = (count: number) => translate(fr, 'auth.account.twoFactor.codesLeft', { count })
    const days = (count: number) => translate(fr, 'auth.account.tokens.days', { count })

    expect([codes(0), codes(1), codes(2)]).toEqual(['Plus aucun code de secours', '1 code de secours restant', '2 codes de secours restants'])
    expect([days(1), days(30)]).toEqual(['Dans 1 jour', 'Dans 30 jours'])
  })
})
