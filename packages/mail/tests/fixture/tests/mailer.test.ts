import type { Mail, Transport } from '@kaynooo/kayjs-mail'
import process from 'node:process'
import { mailer, MailNotConfigured, outbox } from '@kaynooo/kayjs-mail'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mail } from '../src/mail'
import Hello from '../src/mails/hello.kay'
import Kit from '../src/mails/kit.kay'
import Plain from '../src/mails/plain.kay'
import Welcome from '../src/mails/welcome.kay'

const URL = 'https://fixture.test/confirm?token=a&b'

beforeEach(() => outbox.clear())

describe('rendering', () => {
  it('renders a .kay mail as a whole html document, themed by the app\'s settings, and writes its text from it', async () => {
    const rendered = await mail.render({ to: 'ada@example.com', subject: 'Welcome <Ada>', view: Welcome, props: { name: 'Ada', url: URL } })

    expect(rendered.html).toStartWith('<!doctype html><html lang="fr" xmlns:v="urn:schemas-microsoft-com:vml"')
    expect(rendered.html).toContain('<title>Welcome &lt;Ada&gt;</title>')
    expect(rendered.html).toContain('background:#0047ff')
    expect(rendered.text).toBe(`Welcome, Ada\n\nYour account is ready. Confirm your address to start.\n\nConfirm my address (${URL})\n\nOr paste ${URL} into your browser.\n\nSent by the fixture site`)
    expect(rendered).toMatchObject({ from: 'Fixture <hello@fixture.test>', to: ['ada@example.com'], cc: [], bcc: [], subject: 'Welcome <Ada>' })
  })

  it('holds in Outlook for Windows: its settings in the head, the card in a fixed-width table, the button padded by hidden spaces', async () => {
    const { html } = await mail.render({ to: 'ada@example.com', subject: 'Welcome', view: Welcome, props: { name: 'Ada', url: URL } })

    expect(html).toContain('<o:PixelsPerInch>96</o:PixelsPerInch>')
    expect(html).toContain('<!--[if true]><table role="presentation" width="560" align="center"')
    expect(html).toContain('style="max-width:560px;margin:0 auto"')
    expect(html).toContain('bgcolor="#ffffff"')
    expect(html).toContain('mso-hide:all')
    expect(html).toContain('<!--[if mso]><i style="mso-font-width:125%;mso-text-raise:150%" hidden>&emsp;</i><span style="mso-text-raise:75%"><![endif]-->Confirm my address<!--[if mso]></span>')
  })

  it('follows the preheader with invisible filler, so the inbox preview stops there, and leaves it out of the text', async () => {
    const { html, text } = await mail.render({ to: 'ada@example.com', subject: 'Welcome', view: Welcome, props: { name: 'Ada', url: URL } })

    expect(html).toContain(`Your account is ready${'\u034F\u200C\u00A0'.repeat(100)}</div>`)
    expect(text).not.toContain('\u034F')
  })

  it('renders a mail in the language it is given, its component reading that locale\'s messages', async () => {
    const french = await mail.render({ to: 'ada@example.com', subject: 'Salut', view: Hello, lang: 'fr' })
    const english = await mailer({ from: 'hello@fixture.test', queue: { name: 'english-mail' } }).render({ to: 'ada@example.com', subject: 'Hi', view: Hello })

    expect(french.html).toContain('<html lang="fr"')
    expect(french.text).toBe('Bonjour')
    expect(english.html).toContain('<html lang="en"')
    expect(english.text).toBe('Hello')
    await expect(mail.render({ to: 'ada@example.com', subject: 'Hallo', view: Hello, lang: 'de' })).rejects.toThrow('none of the site\'s locales')
  })

  it('offers one-click unsubscribe through the headers RFC 8058 names, refusing a URL that is not https', async () => {
    const single = await mail.render({ to: 'ada@example.com', subject: 'News', text: 'Hi', unsubscribe: 'https://fixture.test/unsubscribe?u=1&t=<x>' })
    const both = await mail.render({ to: 'ada@example.com', subject: 'News', text: 'Hi', unsubscribe: { url: 'https://fixture.test/u', address: 'unsubscribe@fixture.test' } })

    expect(single.headers).toEqual({ 'List-Unsubscribe': '<https://fixture.test/unsubscribe?u=1&t=%3Cx%3E>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
    expect(both.headers['List-Unsubscribe']).toBe('<https://fixture.test/u>, <mailto:unsubscribe@fixture.test>')
    await expect(mail.render({ to: 'ada@example.com', subject: 'News', text: 'Hi', unsubscribe: 'http://fixture.test/u' })).rejects.toThrow('it takes an https URL')
  })

  it('ships a code, a divider, an image, a link, headings by level and columns, each built for Outlook too', async () => {
    const { html, text } = await mail.render({ to: 'ada@example.com', subject: 'Kit', view: Kit })

    expect(html).toContain('<img src="https://fixture.test/logo.png" alt="Fixture" width="120" height="40"')
    expect(html).toContain('font-family:ui-monospace')
    expect(html).toContain('letter-spacing:6px')
    expect(html).toContain('border-top:1px solid #e5e5e0')
    expect(html).toContain('<h2 style="font-size:18px')
    expect(html).toContain('<!--[if true]><td width="251" valign="top"><![endif]--><div style="display:inline-block;width:100%;max-width:251px;vertical-align:top">')
    expect(html).toContain('<a href="https://fixture.test/help" style="color:#0047ff;text-decoration:underline">the help</a>')
    expect(text).toBe('Fixture\n\nYour code\n\n482 913\n\nDetails\n\nLeft\n\nRight\n\nRead the help (https://fixture.test/help).')
  })

  it('takes no props for a mail without required ones, and the text it is given over the one written from the html', async () => {
    const rendered = await mail.render({ to: 'ada@example.com', subject: 'Plain', view: Plain, text: 'Given text' })

    expect(rendered.html).toContain('<p>Nothing to fill in.</p>')
    expect(rendered.text).toBe('Given text')
  })

  it('wraps an html fragment in a document, keeps a whole one, and sends text alone without html', async () => {
    expect((await mail.render({ to: 'a@example.com', subject: 'S', html: '<p>Hi</p>' })).html).toContain('<body style="margin:0;padding:0"><p>Hi</p></body>')
    expect((await mail.render({ to: 'a@example.com', subject: 'S', html: '<html><body>Hi</body></html>' })).html).toBe('<!doctype html><html><body>Hi</body></html>')
    expect(await mail.render({ to: 'a@example.com', subject: 'S', text: 'Just text' })).toMatchObject({ html: undefined, text: 'Just text' })
  })

  it('refuses a mail with no recipient, or an address holding a line break, which would add a recipient of its own', async () => {
    await expect(mail.render({ to: [], subject: 'Nobody', text: 'Hi' })).rejects.toThrow('"Nobody" has no recipient')
    await expect(mail.render({ to: 'ada@example.com\r\nBcc: spam@example.com', subject: 'Spam', text: 'Hi' })).rejects.toThrow('"Spam" has an address holding a line break')
    await expect(mail.render({ to: 'ada@example.com', replyTo: { name: 'Ada', address: 'ada@example.com\nBcc: spam@example.com' }, subject: 'Spam', text: 'Hi' })).rejects.toThrow('line break')
  })

  it('refuses a mail with no recipient before rendering its component', async () => {
    let rendered = false
    const view = () => {
      rendered = true

      return 'Hi'
    }

    await expect(mail.render({ to: [], subject: 'Nobody', view })).rejects.toThrow('has no recipient')
    expect(rendered).toBe(false)
  })
})

describe('the outbox', () => {
  it('keeps what is sent under bun test, found by recipient', async () => {
    const delivery = await mail.send({ to: { name: 'Ada', address: 'Ada@Example.com' }, cc: 'Bob <bob@example.com>', subject: 'One', text: 'Hi' })

    await mail.send({ to: 'carol@example.com', subject: 'Two', text: 'Hi' })

    expect(delivery.accepted).toEqual(['Ada@Example.com', 'bob@example.com'])
    expect(outbox.mails.map(sent => sent.subject)).toEqual(['One', 'Two'])
    expect(outbox.last()?.subject).toBe('Two')
    expect(outbox.to('ada@example.com').map(sent => sent.subject)).toEqual(['One'])
    expect(outbox.to('bob@example.com').map(sent => sent.subject)).toEqual(['One'])
    expect(outbox.find(outbox.last()!.id)?.subject).toBe('Two')
  })
})

describe('the outbox helpers', () => {
  it('gives the links a mail carries, each once, from its html or else its text', async () => {
    await mail.send({ to: 'ada@example.com', subject: 'Welcome', view: Welcome, props: { name: 'Ada', url: URL } })
    await mail.send({ to: 'bob@example.com', subject: 'Reset', text: 'Reset it at https://fixture.test/reset?t=1 (or https://fixture.test/help).' })

    expect(outbox.links(outbox.to('ada@example.com')[0]!)).toEqual([URL])
    expect(outbox.links(outbox.to('bob@example.com')[0]!)).toEqual(['https://fixture.test/reset?t=1', 'https://fixture.test/help'])
  })

  it('waits for a mail to an address, returning one already there at once, and fails after its timeout', async () => {
    const waiting = outbox.waitFor('Ada@Example.com')

    await mail.send({ to: 'bob@example.com', subject: 'Not this one', text: 'Hi' })
    setTimeout(() => void mail.send({ to: 'ada@example.com', subject: 'This one', text: 'Hi' }), 20)

    expect((await waiting).subject).toBe('This one')
    expect((await outbox.waitFor('bob@example.com')).subject).toBe('Not this one')
    await expect(outbox.waitFor('carol@example.com', { timeout: 0.05 })).rejects.toThrow('no mail to carol@example.com reached the outbox within 50 ms')
  })
})

describe('the queue', () => {
  it('renders a mail when enqueued and sends it once drained, retrying a failure', async () => {
    const sent: Mail[] = []
    let failures = 1
    const flaky: Transport = {
      send: async (queued) => {
        if (failures-- > 0)
          throw new Error('server away')

        sent.push(queued)

        return { accepted: [], rejected: [] }
      },
    }
    const queued = mailer({ from: 'q@example.com', transport: flaky, queue: { name: 'flaky-mail', backoff: 0.01 } })

    await queued.enqueue({ to: 'ada@example.com', subject: 'Queued', view: Welcome, props: { name: 'Ada', url: URL } })
    expect(await queued.drain()).toBe(1)
    expect(sent).toEqual([])

    await Bun.sleep(30)
    expect(await queued.drain()).toBe(1)
    expect(sent.map(each => each.subject)).toEqual(['Queued'])
    expect(sent[0]!.html).toContain('Welcome, Ada')
  })
})

describe('configuration', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it('stops a production boot naming each SMTP variable missing', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.SMTP_HOST
    delete process.env.SMTP_FROM

    expect(() => mailer()).toThrow(/SMTP_HOST[\s\S]*SMTP_FROM|SMTP_FROM[\s\S]*SMTP_HOST/)
    expect(() => mailer({ from: 'site@example.com' })).toThrow('SMTP_HOST')
  })

  it('lets an optional mailer boot without its settings, each send then throwing MailNotConfigured before anything is queued', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.SMTP_HOST
    delete process.env.SMTP_FROM

    const optional = mailer({ optional: true, queue: { name: 'optional-mail' } })

    expect(optional.configured).toBe(false)
    expect(mailer({ optional: true, from: 'site@example.com', queue: { name: 'optional-from' } }).configured).toBe(false)

    let refusal: unknown

    try {
      await optional.send({ to: 'a@example.com', subject: 'S', text: 'T' })
    }
    catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(MailNotConfigured)
    expect((refusal as MailNotConfigured).missing).toEqual(['SMTP_HOST', 'SMTP_FROM'])
    await expect(optional.enqueue({ to: 'a@example.com', subject: 'S', text: 'T' })).rejects.toThrow('SMTP_HOST and SMTP_FROM must be set to send mail')
    expect(await optional.drain()).toBe(0)

    process.env.SMTP_HOST = 'smtp.example.com'
    process.env.SMTP_FROM = 'site@example.com'
    expect(mailer({ optional: true, queue: { name: 'optional-set' } }).configured).toBe(true)
  })

  it('stops a production boot on a SMTP_FROM that is no address', () => {
    process.env.NODE_ENV = 'production'
    process.env.SMTP_HOST = 'smtp.example.com'
    process.env.SMTP_FROM = 'Site'

    expect(() => mailer({ queue: { name: 'malformed-from' } })).toThrow('SMTP_FROM')

    for (const valid of ['site@example.com', 'Site <site@example.com>']) {
      process.env.SMTP_FROM = valid
      expect(() => mailer({ queue: { name: 'valid-from' } })).not.toThrow()
    }
  })

  it('stops the boot of a server given a user without a password, or the other way round', () => {
    process.env.NODE_ENV = 'production'
    process.env.SMTP_HOST = 'smtp.example.com'
    process.env.SMTP_FROM = 'site@example.com'
    process.env.SMTP_USER = 'site@example.com'
    delete process.env.SMTP_PASS

    expect(() => mailer()).toThrow('SMTP_USER and SMTP_PASS go together')
    expect(() => mailer({ optional: true })).toThrow('SMTP_USER and SMTP_PASS go together')

    delete process.env.SMTP_USER
    process.env.SMTP_PASS = 'secret'
    expect(() => mailer()).toThrow('SMTP_USER and SMTP_PASS go together')
  })
})
