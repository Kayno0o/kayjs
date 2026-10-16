import type { Action } from 'kay'
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
})
