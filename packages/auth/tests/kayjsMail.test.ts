import { mailer, outbox } from '@kaynooo/kayjs-mail'
import { beforeEach, describe, expect, test } from 'bun:test'
import { AUTH_LINK_KINDS, AUTH_NOTICE_KINDS } from '../../mail/src/auth'
import en from '../../mail/src/messages/en'
import fr from '../../mail/src/messages/fr'
import { builtInTemplates } from '../src/mail'
import { testApp } from './helpers/app'

const PLACEHOLDER = /\{(\w+)\}/g

const LINKS = { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }

beforeEach(() => outbox.clear())

// kayjs-mail is the mailer kay apps use: its send and enqueue fit `email.mailer` as they are.
describe('with kayjs-mail', () => {
  test('sends a mailed link through it, the html wrapped in a document and the text kept as written', async () => {
    const mail = mailer({ from: 'Site <site@site.test>', queue: { name: 'auth-sent' } })
    const ada = testApp({ url: 'https://site.test', site: 'Site', email: { mailer: { send: mail.send }, links: LINKS } }).browser()

    await ada.call('register', { email: 'ada@example.com', password: 'correct horse battery' })

    const sent = outbox.to('ada@example.com')

    expect(sent.map(each => each.subject)).toEqual(['Confirm your email for Site'])
    expect(sent[0]!.from).toBe('Site <site@site.test>')
    expect(sent[0]!.html).toStartWith('<!doctype html><html lang="en"')
    expect(sent[0]!.text).toContain('https://site.test/v?token=')
  })

  test('queues the mails through enqueue, sent once the queue runs', async () => {
    const mail = mailer({ from: 'site@site.test', queue: { name: 'auth-queued' } })
    const ada = testApp({ url: 'https://site.test', site: 'Site', email: { mailer: { send: mail.enqueue }, links: LINKS } }).browser()

    await ada.call('register', { email: 'ada@example.com', password: 'correct horse battery' })
    expect(outbox.mails).toEqual([])

    expect(await mail.drain()).toBe(1)
    expect(outbox.last()?.subject).toBe('Confirm your email for Site')
  })
})

// kayjs-mail writes kayjs-auth's mails again in views of its own: a kind or a wording changed on one side is changed on the other.
describe('kayjs-mail\'s auth views', () => {
  test('cover every kind kayjs-auth sends', () => {
    expect([...AUTH_LINK_KINDS, ...AUTH_NOTICE_KINDS].toSorted() as string[]).toEqual(Object.keys(builtInTemplates.en!).toSorted())
  })

  for (const [locale, messages] of [['en', en], ['fr', fr]] as const) {
    test(`open on kayjs-auth's own lead in ${locale}`, () => {
      const words = messages.mail.auth as unknown as Record<string, { lead: string }> & { link: string }
      const data = { site: 'Site', email: 'ada@example.com', detail: 'Acme', url: 'https://site.test/l', locale }
      const values: Record<string, string> = { site: data.site, email: data.email, detail: data.detail, what: words.link }

      for (const [kind, template] of Object.entries(builtInTemplates[locale]!))
        expect(template(data).text).toContain(words[kind]!.lead.replaceAll(PLACEHOLDER, (_, name: string) => values[name]!))
    })
  }
})
