import type { AuthMail } from '@kaynooo/kayjs-mail'
import { authMailer, mailer, outbox } from '@kaynooo/kayjs-mail'
import { beforeEach, describe, expect, it } from 'bun:test'
import { AUTH_LINK_KINDS, AUTH_NOTICE_KINDS } from '../../../src/auth'
import { authSample } from '../../../src/auth-samples'

const URL = 'https://site.test/verify?token=a&b'

// Mails as kayjs-auth hands them, its own subject, text and html beside.
const link: AuthMail = {
  to: 'ada@example.com',
  kind: 'verify-email',
  site: 'Site',
  locale: 'fr',
  subject: 'kayjs-auth\'s subject',
  text: 'kayjs-auth\'s text',
  html: '<div>kayjs-auth\'s own html</div>',
  url: URL,
  code: '482913',
}

const notice: AuthMail = { ...link, kind: 'new-sign-in', locale: 'en', url: 'https://site.test/sessions', code: undefined }

const mail = mailer({ from: 'Site <site@site.test>', queue: { name: 'auth-mail' } })

beforeEach(() => outbox.clear())

describe('authMailer', () => {
  it('renders a link and a code through the shipped view, in kayjs-mail\'s wording of the mail\'s language, themed by the settings', async () => {
    const { subject, html, text } = await authMailer(mail.render).send(link)

    expect(subject).toBe('Confirmez votre adresse pour Site')
    expect(html).toStartWith('<!doctype html><html lang="fr"')
    expect(html).toContain('>Confirmez votre adresse pour Site</h1>')
    expect(html).toContain('Confirmez ada@example.com comme adresse de votre compte Site.')
    expect(html).toContain('<a class="km-button" href="https://site.test/verify?token=a&amp;b" style="display:inline-block;padding:0.75em 1.25em;font-size:16px;font-weight:600;background:#0047ff')
    expect(html).toContain('Confirmer mon adresse')
    expect(html).toContain('Ou collez ceci dans votre navigateur : <a class="km-link" href="https://site.test/verify?token=a&amp;b"')
    expect(html).toContain('Ou saisissez ce code là où vous l\'avez demandé :')
    expect(html).toContain('482913')
    expect(html).toContain('Le lien est valable 24 heures. Le code est valable 10 minutes, saisi là où vous l\'avez demandé. Si vous n\'avez pas créé de compte, ignorez ce message.</p>')
    expect(html).not.toContain('kayjs-auth\'s own html')
    expect(text).toContain('Confirmez ada@example.com comme adresse de votre compte Site.')
    expect(text).toContain('482913')
  })

  it('writes the detail a mail is about, and only the code when there is no link', async () => {
    const invitation = await authMailer(mail.render).send({ ...link, kind: 'invitation', locale: 'en', detail: 'Acme & Co', code: undefined })
    const code = await authMailer(mail.render).send({ ...link, kind: 'magic-link', locale: 'en', url: undefined })

    expect(invitation.subject).toBe('Join Acme & Co on Site')
    expect(invitation.html).toContain('You are invited to join Acme &amp; Co on Site, with an account at ada@example.com.')
    expect(invitation.html).toContain('If you did not expect it, ignore this mail.</p>')
    expect(code.html).toContain('Here is your code to sign in to Site.')
    expect(code.html).toContain('Your code:')
    expect(code.html).not.toContain('class="km-button"')
    expect(code.html).toContain('The code works for 10 minutes, typed where you asked for it. If you did not ask for it, ignore this mail.</p>')
  })

  it('renders news of a change to the account with its link to review it', async () => {
    const { subject, html } = await authMailer(mail.render).send(notice)

    expect(subject).toBe('New sign-in on Site')
    expect(html).toStartWith('<!doctype html><html lang="en"')
    expect(html).toContain('See where your account is signed in, and end what you do not know: <a class="km-link" href="https://site.test/sessions"')
    expect(html).toContain('If this was not you, reset your password and check your account at once.</p>')
    expect(html).not.toContain('class="km-button"')
  })

  it('takes a line the app\'s messages override, keeping the others', async () => {
    const { subject, html } = await authMailer(mail.render).send({ ...notice, kind: 'password-changed', url: undefined })

    expect(subject).toBe('Password changed on Site')
    expect(html).toContain('Your Site password is a new one.')
    expect(html).toContain('If this was not you, reset your password and check your account at once.</p>')
  })

  it('writes every kind in English and French, each line filled', async () => {
    for (const locale of ['en', 'fr']) {
      for (const kind of [...AUTH_LINK_KINDS, ...AUTH_NOTICE_KINDS]) {
        const { subject, text } = await authMailer(mail.render).send({ ...authSample(kind), locale })

        expect(`${locale} ${kind}: ${subject}`).not.toMatch(/mail\.auth|[{}]|: $/)
        expect(`${locale} ${kind}: ${text}`).not.toMatch(/mail\.auth|[{}]/)
      }
    }
  })

  it('renders a kind through the app\'s own view, which keeps the shipped one around its own lines', async () => {
    const views = { 'reset-password': async () => await import('../src/mails/auth/reset-password.kay'), 'new-sign-in': async () => await import('../src/mails/auth/new-sign-in.kay') }
    const { subject, html } = await authMailer(mail.render, { views }).send({ ...link, kind: 'reset-password', locale: 'en', code: undefined })
    const other = await authMailer(mail.render, { views }).send(link)
    const signIn = await authMailer(mail.render, { views }).send({ ...notice, detail: 'Firefox on Linux' })

    expect(subject).toBe('Reset your Site password')
    expect(html).toContain('>Password help</h1>')
    expect(html).toContain('Forgot your Site password?')
    expect(html).toContain('We never ask for it by mail.')
    expect(html).toContain('Pick a password')
    expect(html).not.toContain('Choose a new password')
    expect(signIn.html).toContain('>New sign-in on Site</h1>')
    expect(signIn.html).toContain('Firefox on Linux')
    expect(signIn.html).toContain('Your sessions: <a class="km-link" href="https://site.test/sessions"')
    expect(signIn.html).toContain('Write to us if it was not you.</p>')
    expect(signIn.html).not.toContain('reset your password')
    expect(html).toContain('The link works for one hour. If you did not ask for it, ignore this mail: your password stays as it is.</p>')
    expect(other.html).not.toContain('Forgot your')
  })

  it('sends a kind it does not know as kayjs-auth wrote it', async () => {
    const { subject, html, text } = await authMailer(mail.render).send({ ...link, kind: 'some-new-kind' })

    expect(subject).toBe('kayjs-auth\'s subject')
    expect(html).toContain('<body style="margin:0;padding:0"><div>kayjs-auth\'s own html</div></body>')
    expect(text).toBe('kayjs-auth\'s text')
  })

  it('sends at once through send, and through the queue through enqueue', async () => {
    await authMailer(mail.send).send(link)
    expect(outbox.last()?.subject).toBe('Confirmez votre adresse pour Site')

    outbox.clear()
    await authMailer(mail.enqueue).send(notice)
    expect(outbox.mails).toEqual([])
    expect(await mail.drain()).toBe(1)
    expect(outbox.last()?.subject).toBe('New sign-in on Site')
  })
})
