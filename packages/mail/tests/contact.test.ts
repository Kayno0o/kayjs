import type { Action } from 'kay'
import type { ContactMailProps } from '../src/contact'
import { beforeEach, describe, expect, it } from 'bun:test'
import { action, s } from 'kay'
import { testSite } from 'kay/test'
import { contactForm } from '../src/contact'
import { mailer } from '../src/mailer'
import { outbox } from '../src/outbox'

const SINK = Symbol.for('kay.log')

interface Answers { name: string, email: string, phone?: string, topic: 'quote' | 'other', message: string }

// Imported by path, as the fixture is no part of this package's type check.
const { contact } = await import(`${import.meta.dir}/fixture/src/routes/contact.kay`) as { contact: Action<Answers, unknown> }
const { consented } = await import(`${import.meta.dir}/fixture/src/routes/consent.kay`) as { consented: Action<Answers & { consent?: boolean, website?: string, nectar?: string }, unknown> }
const { noRecipient, serverDown, worded, unrendered } = await import(`${import.meta.dir}/fixture/src/routes/broken.kay`) as Record<'noRecipient' | 'serverDown' | 'worded' | 'unrendered', Action<Answers, unknown>>

// Spread into `action`, the form keeps its input typed: the extra field is there, and a field it does not have is refused.
const typed = action(...contactForm(mailer({ from: 'a@fixture.test' }), { fields: { phone: s.Optional(s.String({ maxLength: 30 })) } }))
const held: Action<{ name: string, email: string, message: string, phone?: string }, unknown, 'website'> = typed
// @ts-expect-error `nope` is no field of the contact form
const dropped: Action<{ nope: number }, unknown, 'website'> = typed

const fields: Answers = { name: 'Ada Lovelace', email: 'ada@example.com', phone: '06 12 34 56 78', topic: 'quote', message: 'Hello,\nI would like a quote.' }

void [held, dropped]

beforeEach(() => outbox.clear())

async function site() {
  return testSite({ root: 'tests/fixture' })
}

describe('the default contact mail', () => {
  it('renders from `site` alone, without the deprecated `origin`', async () => {
    const { default: view } = await import('../src/contact-mail.kay') as { default: never }
    const props = { subject: 'Hi', name: 'Ada', email: 'ada@example.com', message: 'Hello', fields: [], site: 'https://fixture.test' } satisfies ContactMailProps

    await mailer({ from: 'a@fixture.test' }).send({ to: 'team@fixture.test', subject: props.subject, view, props })

    expect(outbox.to('team@fixture.test')[0]!.text).toContain('Sent from the contact form of https://fixture.test.')
  })
})

describe('contactForm', () => {
  it('mails the answers to the site with the visitor in replyTo and the message quoted', async () => {
    const { call } = await site()

    await call(contact, fields)

    const [sent] = outbox.to('team@fixture.test')

    expect(sent).toBeDefined()
    expect(sent!.replyTo).toEqual({ name: 'Ada Lovelace', address: 'ada@example.com' })
    expect(sent!.subject).toBe('Message from Ada Lovelace')
    expect(sent!.text).toContain('Subject: quote')
    expect(sent!.text).toContain('Phone: 06 12 34 56 78')
    expect(sent!.text).toContain('I would like a quote.')
  })

  it('refuses a message holding too many links, in the page\'s language', async () => {
    const { refusal } = await site()
    const message = 'http://a.test http://b.test https://c.test https://d.test'

    expect((await refusal(contact, { ...fields, message })).errors['']).toBe('No more than 3 links per message.')
    expect((await refusal(contact, { ...fields, message }, { from: '/fr/contact' })).errors['']).toBe('Pas plus de 3 liens par message.')
    expect(outbox.last()).toBeUndefined()
  })

  it('answers 503 with the way else to reach the site when the mail has no recipient', async () => {
    const { refusal } = await site()
    const refused = await refusal(noRecipient, fields)

    expect(refused.status).toBe(503)
    expect(refused.errors['']).toBe('The form cannot send messages yet: write to hello@fixture.test.')
  })

  it('answers 502 when the mail server fails', async () => {
    const { refusal } = await site()
    const refused = await refusal(serverDown, fields)

    expect(refused.status).toBe(502)
    expect(refused.errors['']).toBe('Your message could not be sent. Please try again later.')
  })

  it('logs a failed send once, the mailer having logged it already', async () => {
    const { refusal } = await site()
    const calls: unknown[][] = []
    const global = globalThis as { [SINK]?: unknown }
    const sink = global[SINK]

    global[SINK] = (...args: unknown[]) => calls.push(args)

    try {
      await refusal(serverDown, fields)
    }
    finally {
      global[SINK] = sink
    }

    expect(calls.filter(call => call[0] === 'error')).toHaveLength(1)
  })

  it('refuses a name holding a line break and a missing topic with the field\'s message', async () => {
    const { refusal } = await site()
    const refused = await refusal(contact, { ...fields, name: 'Ada\nBcc: x@y.test', topic: undefined as unknown as Answers['topic'] })

    expect(refused.errors.name).toBe('Please write your name, on one line.')
    expect(refused.errors.topic).toBeDefined()
    expect(outbox.last()).toBeUndefined()
  })

  it('trims the name and the message before mailing them', async () => {
    const { call } = await site()

    await call(contact, { ...fields, name: '  Ada  ', message: '  Hello  ' })

    expect(outbox.last()!.replyTo).toEqual({ name: 'Ada', address: 'ada@example.com' })
  })

  it('refuses an extra field named like one the form has', () => {
    const send = async () => Promise.reject(new Error('unused'))

    expect(() => contactForm({ send } as never, { fields: { email: s.String() } })).toThrow('already has the field email')
  })

  it('renders the honeypot, and limits the posts that went through, naming how else to reach the site', async () => {
    const { call, refusal, visit } = await site()

    expect((await visit('/contact')).html).toContain('name="website"')

    for (let sent = 0; sent < 5; sent++) {
      try {
        await call(contact, fields)
      }
      catch {}
    }

    const refused = await refusal(contact, fields)

    expect(refused.status).toBe(429)
    expect(refused.errors['']).toBe('Too many messages sent from here in a short time: try again in a few minutes, or write to hello@fixture.test.')
  })

  it('words the schema\'s refusals in the page\'s language, and an errors option replaces them', async () => {
    const { refusal } = await site()
    const bad = { ...fields, email: 'nope' }

    expect((await refusal(contact, bad)).errors.email).toBe('Please write a valid email address.')
    expect((await refusal(contact, bad, { from: '/fr/contact' })).errors.email).toBe('Merci d\'écrire une adresse e-mail valide.')
  })

  it('refuses a field with the errors option, a text or a function', async () => {
    const { refusal } = await site()
    const refused = await refusal(worded, { ...fields, name: '', email: 'nope' })

    expect(refused.errors.email).toBe('Bad address')
    expect(refused.errors.name).toBe('A name, please')
    expect(refused.errors.message).toBeUndefined()
  })

  it('words a refused field in English when the messages are not brought in', () => {
    const [{ properties }] = contactForm(mailer({ from: 'a@fixture.test' })) as unknown as [{ properties: Record<string, { error: () => string }> }]

    expect(properties.email!.error()).toBe('Please write a valid email address.')
  })

  it('logs a mail the view could not render, with the error', async () => {
    const { refusal } = await site()
    const calls: unknown[][] = []
    const global = globalThis as { [SINK]?: unknown }
    const sink = global[SINK]

    global[SINK] = (...args: unknown[]) => calls.push(args)

    try {
      expect((await refusal(unrendered, fields)).status).toBe(502)
    }
    finally {
      global[SINK] = sink
    }

    const [level, message, error] = calls.find(call => call[0] === 'error') ?? []

    expect(level).toBe('error')
    expect(message).toBe('the contact mail could not be sent')
    expect((error as Error).message).toContain('the view does not render')
  })

  it('renames the honeypot, leaving website free as a field of the form', async () => {
    const { visit } = await site()
    const { html } = await visit('/consent')

    expect(html).toContain('name="nectar"')
    expect(html.match(/name="website"/g)).toHaveLength(1)
    expect(html).not.toContain('name="website" type="text" tabindex="-1"')
  })

  it('answers a bot filling the renamed honeypot as if it worked, mailing nothing', async () => {
    const { call } = await site()
    const post = (extra: Record<string, string>) => {
      const body = new FormData()

      for (const [key, value] of Object.entries({ name: 'Ada', email: 'ada@example.com', message: 'Hello', consent: 'on', ...extra }))
        body.set(key, value)

      return body as never
    }

    expect(await call(consented, post({ nectar: 'spam' }))).toBeUndefined()
    expect(outbox.last()).toBeUndefined()
    await call(consented, post({ website: 'https://ada.test' }))
    expect(outbox.last()).toBeDefined()
  })

  it('answers a bot filling the renamed honeypot without consent as if it worked', async () => {
    const { call } = await site()
    const body = new FormData()

    for (const [key, value] of Object.entries({ name: 'Ada', email: 'ada@example.com', message: 'Hello', nectar: 'spam' }))
      body.set(key, value)

    expect(await call(consented, body as never)).toBeUndefined()
    expect(outbox.last()).toBeUndefined()
  })

  it('keeps website as the honeypot by default', async () => {
    const { call } = await site()
    const body = new FormData()

    for (const [key, value] of Object.entries({ name: 'Ada', email: 'ada@example.com', message: 'Hello', topic: 'quote', website: 'spam' }))
      body.set(key, value)

    expect(await call(contact, body as never)).toBeUndefined()
    expect(outbox.last()).toBeUndefined()
  })

  it('lets a person fill a website field once the honeypot has another name', async () => {
    const { call } = await site()

    await call(consented, { ...fields, consent: true, website: 'https://ada.test' })

    expect(outbox.last()!.text).toContain('Website: https://ada.test')
  })

  it('refuses an unticked or missing consent in the page\'s language, and mails nothing', async () => {
    const { refusal } = await site()

    for (const consent of [false, undefined]) {
      const refused = await refusal(consented, { ...fields, consent } as never)

      expect(refused.errors.consent).toBe('Please tick the box to send your message.')
    }

    expect((await refusal(consented, { ...fields, consent: false }, { from: '/fr/consent' })).errors.consent).toBe('Merci de cocher la case pour envoyer votre message.')
    expect(outbox.last()).toBeUndefined()
  })

  it('leaves the consent out of the mail', async () => {
    const { call } = await site()

    await call(consented, { ...fields, consent: true })

    const sent = outbox.last()!

    expect(sent.text).not.toMatch(/consent/i)
    expect(sent.html).not.toMatch(/consent/i)
  })

  it('still refuses a header injected through the name or the email beside consent', async () => {
    const { refusal } = await site()
    const refused = await refusal(consented, { ...fields, consent: true, name: 'Ada\r\nBcc: x@y.test', email: 'ada@example.com\r\nBcc: x@y.test' })

    expect(refused.errors.name).toBeDefined()
    expect(refused.errors.email).toBeDefined()
    expect(outbox.last()).toBeUndefined()
  })

  it('refuses a field named like the honeypot or the consent', () => {
    const send = async () => Promise.reject(new Error('unused'))

    expect(() => contactForm({ send } as never, { honeypot: 'nectar', fields: { nectar: s.String() } })).toThrow('already has the field nectar')
    expect(() => contactForm({ send } as never, { consent: true, fields: { consent: s.Boolean() } })).toThrow('already has the field consent')
    expect(() => contactForm({ send } as never, { honeypot: 'email' })).toThrow('cannot use `email` as its honeypot')
    expect(() => contactForm({ send } as never, { fields: { website: s.String() } })).toThrow('already has the field website')
  })

  it('types the renamed honeypot and the consent', () => {
    const renamed = action(...contactForm(mailer({ from: 'a@fixture.test' }), { honeypot: 'nectar', consent: true }))
    const typedAs: Action<{ name: string, email: string, message: string, consent: true }, unknown, 'nectar'> = renamed

    void typedAs
  })
})
