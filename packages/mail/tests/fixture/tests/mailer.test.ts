import type { Mail, Transport } from '@kaynooo/kayjs-mail'
import process from 'node:process'
import { mailer, MailNotConfigured, outbox } from '@kaynooo/kayjs-mail'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mail } from '../src/mail'
import Plain from '../src/mails/plain.kay'
import Welcome from '../src/mails/welcome.kay'

const URL = 'https://fixture.test/confirm?token=a&b'

beforeEach(() => outbox.clear())

describe('rendering', () => {
  it('renders a .kay mail as a whole html document, themed by the app\'s settings, and writes its text from it', async () => {
    const rendered = await mail.render({ to: 'ada@example.com', subject: 'Welcome <Ada>', view: Welcome, props: { name: 'Ada', url: URL } })

    expect(rendered.html).toStartWith('<!doctype html><html lang="fr"><head><meta charset="utf-8">')
    expect(rendered.html).toContain('<title>Welcome &lt;Ada&gt;</title>')
    expect(rendered.html).toContain('background:#0047ff')
    expect(rendered.text).toBe(`Welcome, Ada\n\nYour account is ready. Confirm your address to start.\n\nConfirm my address (${URL})\n\nOr paste ${URL} into your browser.\n\nSent by the fixture site`)
    expect(rendered).toMatchObject({ from: 'Fixture <hello@fixture.test>', to: ['ada@example.com'], cc: [], bcc: [], subject: 'Welcome <Ada>' })
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
