import type { AuthMail } from '@kaynooo/kayjs-mail'
import { authMailer, mailer, outbox } from '@kaynooo/kayjs-mail'
import { beforeEach, describe, expect, it } from 'bun:test'
import Hello from '../src/mails/hello.kay'

const URL = 'https://site.test/verify?token=a&b'

// A mail as kayjs-auth hands it, its wording in parts as well.
const link: AuthMail = {
  to: 'ada@example.com',
  kind: 'verify-email',
  locale: 'fr',
  subject: 'Confirmez votre adresse pour Site',
  text: 'Confirmez ada@example.com.\n\nhttps://site.test/verify?token=a&b\n\nOu saisissez ce code : 482913\n\nLe lien est valable 24 heures.',
  html: '<div>kayjs-auth\'s own html</div>',
  url: URL,
  code: '482913',
  parts: { type: 'link', lead: 'Confirmez ada@example.com comme adresse de votre compte Site.', button: 'Confirmer mon adresse', orPaste: 'Ou collez ceci dans votre navigateur :', codeLead: 'Ou saisissez ce code :', ending: 'Le lien est valable 24 heures.' },
}

const notice: AuthMail = {
  to: 'ada@example.com',
  kind: 'new-sign-in',
  locale: 'en',
  subject: 'New sign-in on Site',
  text: 'Your Site account was just signed into.\n\nSee where: https://site.test/sessions\n\nIf this was not you, reset your password.',
  html: '<div>kayjs-auth\'s own html</div>',
  url: 'https://site.test/sessions',
  parts: { type: 'notice', lead: 'Your Site account was just signed into.', review: 'See where your account is signed in:', ending: 'If this was not you, reset your password.' },
}

const mail = mailer({ from: 'Site <site@site.test>', queue: { name: 'auth-mail' } })

beforeEach(() => outbox.clear())

describe('authMailer', () => {
  it('renders a link and a code through the shipped components, themed by the settings and in the mail\'s language, kayjs-auth\'s text kept', async () => {
    const { html, text } = await authMailer(mail.render).send(link)

    expect(html).toStartWith('<!doctype html><html lang="fr"')
    expect(html).toContain('>Confirmez votre adresse pour Site</h1>')
    expect(html).toContain('<a class="km-button" href="https://site.test/verify?token=a&amp;b" style="display:inline-block;padding:0.75em 1.25em;font-size:16px;font-weight:600;background:#0047ff')
    expect(html).toContain('Confirmer mon adresse')
    expect(html).toContain('Ou collez ceci dans votre navigateur : <a class="km-link" href="https://site.test/verify?token=a&amp;b"')
    expect(html).toContain('letter-spacing:6px')
    expect(html).toContain('482913')
    expect(html).toContain('Le lien est valable 24 heures.</p>')
    expect(html).not.toContain('kayjs-auth\'s own html')
    expect(text).toBe(link.text)
  })

  it('renders news of a change to the account with its link to review it', async () => {
    const { html, text } = await authMailer(mail.render).send(notice)

    expect(html).toStartWith('<!doctype html><html lang="en"')
    expect(html).toContain('See where your account is signed in: <a class="km-link" href="https://site.test/sessions"')
    expect(html).toContain('If this was not you, reset your password.</p>')
    expect(html).not.toContain('class="km-button"')
    expect(text).toBe(notice.text)
  })

  it('renders a kind through the app\'s own view, given the mail, in its language', async () => {
    const { html } = await authMailer(mail.render, { views: { 'verify-email': Hello } }).send(link)

    expect(html).toContain('<html lang="fr"')
    expect(html).toContain('Bonjour')
    expect(html).not.toContain('Confirmer mon adresse')
  })

  it('sends the html of an app\'s own kayjs-auth templates as it is', async () => {
    const own: AuthMail = { ...link, parts: undefined }
    const { html, text } = await authMailer(mail.render).send(own)

    expect(html).toContain('<body style="margin:0;padding:0"><div>kayjs-auth\'s own html</div></body>')
    expect(text).toBe(link.text)
  })

  it('sends at once through send, and through the queue through enqueue', async () => {
    await authMailer(mail.send).send(link)
    expect(outbox.last()?.subject).toBe(link.subject)

    outbox.clear()
    await authMailer(mail.enqueue).send(notice)
    expect(outbox.mails).toEqual([])
    expect(await mail.drain()).toBe(1)
    expect(outbox.last()?.subject).toBe(notice.subject)
  })
})
