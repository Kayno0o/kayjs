import type { EmailOptions } from '../src/email'
import type { Mail } from '../src/mail'
import { describe, expect, test } from 'bun:test'
import { acceptedLocales, pickLocale } from '../src/locale'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }

function setup(email: Partial<EmailOptions> = {}) {
  const mails: Mail[] = []
  const app = testApp({
    url: 'https://site.test',
    site: 'Site',
    email: {
      mailer: {
        send: (mail) => {
          mails.push(mail)
        },
      },
      links: LINKS,
      requireVerified: false,
      ...email,
    },
  })

  return { ...app, mails }
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
    const { browser, mails, store } = setup({ locales: ['en', 'fr'] })
    const ada = browser()
    const { user } = await ada.json('/call/register', speaking('en', { email: 'ada@example.com', password: PASSWORD, locale: 'fr' })) as { user: { id: string } }

    expect(mails.at(-1)!.locale).toBe('fr')
    expect(await ada.call('setLocale', 'not a tag')).toBe(false)
    expect(await ada.call('setLocale', 'en-GB')).toBe(true)
    expect(await ada.json('/me')).toMatchObject({ locale: 'en-GB' })

    await ada.call('requestPasswordReset', 'ada@example.com')
    await Bun.sleep(0)

    expect(mails.at(-1)).toMatchObject({ kind: 'reset-password', locale: 'en' })

    await store.users.update(user.id, { locale: null })
    await browser().json('/call/requestPasswordReset', speaking('fr-BE', 'ada@example.com'))
    await Bun.sleep(0)

    expect(mails.at(-1)).toMatchObject({ kind: 'reset-password', locale: 'fr', subject: 'Réinitialisez votre mot de passe Site' })
  })

  test('the app\'s templates go over every language, and a translation over them for its own', async () => {
    const { browser, mails } = setup({
      locales: ['en', 'de'],
      templates: { 'magic-link': data => ({ subject: `magic ${data.locale}`, text: '', html: '' }) },
      translations: { de: { 'verify-email': data => ({ subject: `Bestätigen ${data.site}`, text: '', html: '' }) } },
    })

    await browser().json('/call/register', speaking('de-AT', { email: 'ada@example.com', password: PASSWORD }))
    await browser().json('/call/requestMagicLink', speaking('de', 'ada@example.com'))
    await Bun.sleep(0)

    expect(mails.map(mail => [mail.kind, mail.locale, mail.subject])).toEqual([['verify-email', 'de', 'Bestätigen Site'], ['magic-link', 'de', 'magic de']])
  })
})
