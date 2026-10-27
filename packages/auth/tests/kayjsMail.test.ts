import { mailer, outbox } from '@kaynooo/kayjs-mail'
import { beforeEach, describe, expect, test } from 'bun:test'
import { AUTH_LINK_KINDS, AUTH_MAIL_SAMPLES, AUTH_MAIL_WORDING, AUTH_NOTICE_KINDS } from 'kay/library/auth-mails'
import { builtInTemplates } from '../src/mail'
import { testApp } from './helpers/app'

// A placeholder left as it was, or a value missing from a line.
const UNFILLED = /[{}]|undefined|: $/

const LINKS = { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }

beforeEach(() => outbox.clear())

// kayjs-mail is the mailer kay apps use: its send and enqueue fit `email.mailer` as they are.
describe('with kayjs-mail', () => {
  test('sends a mailed link through it, the html wrapped in a document and the text kept as written', async () => {
    const mail = mailer({ from: 'Site <site@site.test>', queue: { name: 'auth-sent' } })
    const ada = testApp({ site: 'https://site.test', name: 'Site', email: { mailer: { send: mail.send }, links: LINKS } }).browser()

    await ada.call('register', { email: 'ada@example.com', password: 'correct horse battery' })

    const sent = outbox.to('ada@example.com')

    expect(sent.map(each => each.subject)).toEqual(['Confirm your email for Site'])
    expect(sent[0]!.from).toBe('Site <site@site.test>')
    expect(sent[0]!.html).toStartWith('<!doctype html><html lang="en"')
    expect(sent[0]!.text).toContain('https://site.test/v?token=')
  })

  test('queues the mails through enqueue, sent once the queue runs', async () => {
    const mail = mailer({ from: 'site@site.test', queue: { name: 'auth-queued' } })
    const ada = testApp({ site: 'https://site.test', name: 'Site', email: { mailer: { send: mail.enqueue }, links: LINKS } }).browser()

    await ada.call('register', { email: 'ada@example.com', password: 'correct horse battery' })
    expect(outbox.mails).toEqual([])

    expect(await mail.drain()).toBe(1)
    expect(outbox.last()?.subject).toBe('Confirm your email for Site')
  })
})

// kayjs-auth's own mails, for a mailer other than kayjs-mail's authMailer, are written from the list kay keeps for both libraries: every kind in every language shipped, each line filled.
describe('kayjs-auth\'s own mails', () => {
  test('cover every kind of the shared list, in every language it words', () => {
    expect(Object.keys(builtInTemplates).toSorted()).toEqual(Object.keys(AUTH_MAIL_WORDING).toSorted())

    for (const templates of Object.values(builtInTemplates))
      expect(Object.keys(templates).toSorted()).toEqual([...AUTH_LINK_KINDS, ...AUTH_NOTICE_KINDS].toSorted())
  })

  for (const [locale, words] of Object.entries(AUTH_MAIL_WORDING)) {
    test(`write each kind's lines in ${locale}, with nothing left to fill`, () => {
      for (const kind of [...AUTH_LINK_KINDS, ...AUTH_NOTICE_KINDS]) {
        const data = { name: 'Site', email: 'ada@example.com', locale, maxAge: { link: 3600, code: 600 }, ...AUTH_MAIL_SAMPLES[kind] }
        const { subject, text, html } = builtInTemplates[locale]![kind](data)
        const lead = words[kind].lead.replaceAll('{site}', 'Site').replaceAll('{email}', data.email).replaceAll('{detail}', data.detail ?? '').replaceAll('{what}', words.link)

        expect(`${kind}: ${subject}`).not.toMatch(UNFILLED)
        expect(`${kind}: ${text}`).not.toMatch(UNFILLED)
        expect(subject).not.toBe('')
        expect(text).toStartWith(lead)
        expect(html).toContain(`lang="${locale}"`)
      }
    })
  }
})
