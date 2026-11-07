import type { Action } from 'kay'
import type { Mail } from '../src/types'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { memoryJobs } from 'kay/server'
import { scratchDir, testSite } from 'kay/test'
import { contactForm } from '../src/contact'
import { openLists } from '../src/list-store'
import { mailer } from '../src/mailer'
import { outbox } from '../src/outbox'

const site = await testSite({ root: 'tests/fixture' })
const { subscribeHooked } = await import(`${import.meta.dir}/fixture/src/routes/subscribe.kay`) as Record<'subscribeHooked', Action<{ email: string }, unknown>>
const { mail: fixtureMail, heard } = await import(`${import.meta.dir}/fixture/src/mail`) as typeof import('./fixture/src/mail')

const SINK = Symbol.for('kay.log')
let names = 0
let counter = 0

const fresh = (): string => `hook${++counter}-${Math.random().toString(36).slice(2, 8)}@example.com`

// What the promise rejected with, none when it resolved.
async function caught(run: Promise<unknown>): Promise<unknown> {
  try {
    await run

    return undefined
  }
  catch (error) {
    return error
  }
}

const statusOf = (error: unknown): number | undefined => (error as Record<symbol, { status: number } | undefined>)[Symbol.for('kay.refused')]?.status

function silenced(): void {
  ;(globalThis as { [SINK]?: unknown })[SINK] = () => undefined
}

beforeAll(() => {
  process.env.MAIL_EVENTS_POSTMARK = 'hook:s3cret'
})

beforeEach(() => {
  outbox.clear()
  heard.length = 0
  silenced()
})

afterEach(() => {
  ;(globalThis as { [SINK]?: unknown })[SINK] = undefined
})

// Drains the queue until the condition holds, for a retry or a pace that waits.
async function drainUntil(app: { drain: () => Promise<number> }, done: () => boolean): Promise<void> {
  for (let round = 0; round < 100 && !done(); round++) {
    await app.drain()
    await Bun.sleep(20)
  }
}

async function refusing(): Promise<never> {
  throw new Error('550 mailbox unavailable')
}

// A queue of its own, so two tests never claim each other's mails.
const queued = () => ({ store: memoryJobs(), name: `hooks${names++}`, attempts: 1 })

describe('beforeSend', () => {
  it('changes the mail before it goes, for a send and for a queued mail', async () => {
    const app = mailer({ from: 'a@example.com', queue: queued(), beforeSend: ({ mail }) => ({ headers: { ...mail.headers, 'X-App': 'kay' }, subject: `[app] ${mail.subject}` }) })

    await app.send({ to: 'direct@example.com', subject: 'Hi', text: 'Hello' })
    await app.enqueue({ to: 'queued@example.com', subject: 'Hi', text: 'Hello' })
    await app.drain()

    for (const to of ['direct@example.com', 'queued@example.com']) {
      expect(outbox.to(to)[0]!.subject).toBe('[app] Hi')
      expect(outbox.to(to)[0]!.headers['X-App']).toBe('kay')
    }
  })

  it('is told the mail and the context, once per mail on either path', async () => {
    const seen: string[] = []
    const app = mailer({ from: 'a@example.com', queue: queued(), beforeSend: ({ mail, context }) => void seen.push(`${mail.subject}:${'request' in context}`) })

    await app.send({ to: 'a@example.com', subject: 'one', text: 'x' })
    await app.enqueue({ to: 'a@example.com', subject: 'two', text: 'x' })
    await app.drain()

    expect(seen).toEqual(['one:true', 'two:true'])
  })

  it('refuses with false: nothing is sent or queued, and the caller catches a 403 refusal', async () => {
    const app = mailer({ from: 'a@example.com', queue: queued(), beforeSend: ({ mail }) => mail.subject === 'drop' ? false : undefined })

    const direct = await caught(app.send({ to: 'a@example.com', subject: 'drop', text: 'x' }))
    const enqueued = await caught(app.enqueue({ to: 'a@example.com', subject: 'drop', text: 'x' }))

    for (const error of [direct, enqueued])
      expect(statusOf(error)).toBe(403)

    expect(await app.drain()).toBe(0)
    expect(outbox.mails).toHaveLength(0)
  })

  it('refuses with a message and status when it throws refuse()', async () => {
    const { refuse } = await import('kay')
    const app = mailer({ from: 'a@example.com', beforeSend: () => refuse('No mail to a test address', { status: 422 }) })
    const error = await caught(app.send({ to: 'a@example.com', subject: 'x', text: 'x' }))

    expect((error as Error).message).toBe('No mail to a test address')
    expect(statusOf(error)).toBe(422)
    expect(outbox.mails).toHaveLength(0)
  })

  it('fails closed with a 500 refusal when it throws anything else, and tells no onError', async () => {
    const failed: unknown[] = []
    const app = mailer({ from: 'a@example.com', beforeSend: () => {
      throw new Error('crm down')
    }, onError: event => void failed.push(event) })
    const error = await caught(app.send({ to: 'a@example.com', subject: 'x', text: 'x' }))

    expect(statusOf(error)).toBe(500)
    expect(outbox.mails).toHaveLength(0)
    expect(failed).toHaveLength(0)
  })
})

describe('onSend', () => {
  it('is told the mail and its delivery once, for a send and for a queued mail', async () => {
    const told: { subject: string, response: string | undefined }[] = []
    const app = mailer({ from: 'a@example.com', queue: queued(), onSend: ({ mail, delivery }) => void told.push({ subject: mail.subject, response: delivery.response }) })

    await app.send({ to: 'a@example.com', subject: 'direct', text: 'x' })
    await app.enqueue({ to: 'a@example.com', subject: 'queued', text: 'x' })
    await app.drain()

    expect(told).toEqual([{ subject: 'direct', response: 'kept in the outbox' }, { subject: 'queued', response: 'kept in the outbox' }])
  })

  it('is told once for a queued mail that took a retry', async () => {
    let attempts = 0
    const told: string[] = []
    const app = mailer({ from: 'a@example.com', queue: { ...queued(), attempts: 2, backoff: '1ms' }, transport: { send: async (mail: Mail) => {
      if (++attempts === 1)
        throw new Error('try again')

      return { accepted: [String(mail.to[0])], rejected: [] }
    } }, onSend: ({ mail }) => void told.push(mail.subject), onError: ({ mail }) => void told.push(`error:${mail.subject}`) })

    await app.enqueue({ to: 'a@example.com', subject: 'retried', text: 'x' })
    await drainUntil(app, () => told.length > 0)
    await app.drain()
    expect(told).toEqual(['retried'])
  })

  it('does not fail the send when it throws', async () => {
    const app = mailer({ from: 'a@example.com', onSend: () => {
      throw new Error('crm down')
    } })

    expect((await app.send({ to: 'a@example.com', subject: 'x', text: 'x' })).accepted).toEqual(['a@example.com'])
    expect(outbox.mails).toHaveLength(1)
  })

  it('is not told for a mail whose recipients are all suppressed', async () => {
    const told: string[] = []
    const app = mailer({ from: 'a@example.com', onSend: ({ mail }) => void told.push(mail.subject) })
    const address = fresh()

    await app.suppress(address)
    await app.send({ to: address, subject: 'skipped', text: 'x' })

    expect(told).toEqual([])
  })
})

describe('onError', () => {
  it('is told once with the mail and the error when a send fails', async () => {
    const told: { subject: string, message: string }[] = []
    const app = mailer({ from: 'a@example.com', transport: { send: refusing }, onError: ({ mail, error }) => void told.push({ subject: mail.subject, message: (error).message }) })

    await expect(app.send({ to: 'a@example.com', subject: 'x', text: 'x' })).rejects.toThrow('550 mailbox unavailable')
    expect(told).toEqual([{ subject: 'x', message: '550 mailbox unavailable' }])
  })

  it('is told once, after the last attempt, for a queued mail, and still runs queue.onError', async () => {
    let tries = 0
    const told: string[] = []
    const app = mailer({ from: 'a@example.com', queue: { ...queued(), attempts: 2, backoff: '1ms', onError: () => void told.push('queue') }, transport: { send: async () => {
      tries++

      return refusing()
    } }, onError: ({ mail }) => void told.push(mail.subject) })

    await app.enqueue({ to: 'a@example.com', subject: 'gone', text: 'x' })
    await drainUntil(app, () => told.length > 1)
    await app.drain()
    expect(told).toEqual(['gone', 'queue'])
    expect(tries).toBe(2)
  })

  it('does not change the error a throwing observer sits beside', async () => {
    const app = mailer({ from: 'a@example.com', transport: { send: refusing }, onError: () => {
      throw new Error('observer broke')
    } })

    await expect(app.send({ to: 'a@example.com', subject: 'x', text: 'x' })).rejects.toThrow('550 mailbox unavailable')
  })
})

describe('onSuppress', () => {
  it('is told the address, reason and source of a bounce from a provider', async () => {
    const address = fresh()
    const body = JSON.stringify({ RecordType: 'Bounce', MessageStream: 'outbound', Type: 'HardBounce', TypeCode: 1, Name: 'Hard bounce', Email: address, From: 'hello@fixture.test', Inactive: true, CanActivate: false })
    const response = await site.fetch('/_kay/mail/events/postmark', { method: 'POST', body, headers: { authorization: `Basic ${Buffer.from('hook:s3cret').toString('base64')}` } })

    expect(response.status).toBe(200)
    expect(heard.filter(({ name }) => name === 'suppress').map(({ event }) => ({ address: event.address, reason: event.reason, source: event.source }))).toEqual([{ address, reason: 'bounce', source: 'postmark' }])
  })

  it('is told a manual suppression too, with the normalised address, and nothing for a string that is no address', async () => {
    const address = fresh()

    await fixtureMail.suppress(address.toUpperCase(), 'complaint')
    await fixtureMail.suppress('not an address')

    expect(heard.map(({ name, event }) => [name, event.address, event.reason, event.source])).toEqual([['suppress', address, 'complaint', 'manual']])
  })

  it('does not fail the route when it throws', async () => {
    const app = mailer({ from: 'a@example.com', onSuppress: () => {
      throw new Error('crm down')
    } })

    expect(await app.suppress(fresh())).toBe(true)
  })
})

describe('the list hooks', () => {
  const confirmLink = (token: string) => `/_kay/mail/list/confirm?token=${token}`

  it('tell a sign-up, its confirmation and its unsubscribe once each, with the list and the address', async () => {
    const email = fresh()

    await site.call(subscribeHooked, { email })
    await site.call(subscribeHooked, { email })

    const confirmation = await outbox.waitFor(email, { site, find: sent => sent.subject.startsWith('Confirm') })
    const confirm = outbox.token(confirmation, '/confirm')

    expect((await site.fetch(confirmLink(confirm), { method: 'POST' })).status).toBe(200)
    expect((await site.fetch(confirmLink(confirm), { method: 'POST' })).status).toBe(200)

    await fixtureMail.list('hooked').unsubscribe(email)
    await fixtureMail.list('hooked').unsubscribe(email)

    expect(heard.map(({ name, event }) => [name, event.list, event.email])).toEqual([['subscribe', 'hooked', email], ['confirm', 'hooked', email], ['unsubscribe', 'hooked', email]])
  })

  it('tell an unsubscribe by its link', async () => {
    const email = fresh()

    await site.call(subscribeHooked, { email })

    const confirm = outbox.token(await outbox.waitFor(email, { site, find: sent => sent.subject.startsWith('Confirm') }), '/confirm')

    await site.fetch(confirmLink(confirm), { method: 'POST' })
    await fixtureMail.list('hooked').send({ subject: 'News', text: 'Hello' })
    await fixtureMail.drain()

    const unsubscribe = outbox.token(await outbox.waitFor(email, { site, find: sent => sent.subject === 'News' }), '/unsubscribe')

    expect((await site.fetch(`/_kay/mail/list/unsubscribe?token=${unsubscribe}`, { method: 'POST' })).status).toBe(200)
    expect(heard.filter(({ name }) => name === 'unsubscribe').map(({ event }) => event.email)).toEqual([email])
  })

  it('do not fail the action or the link when one throws', async () => {
    const email = fresh()
    const file = join(await scratchDir('hooks-'), 'list.sqlite')
    const app = mailer({ from: 'a@example.com' })
    const list = app.list('loud', { file, onUnsubscribe: () => {
      throw new Error('crm down')
    } })
    const lists = openLists(file)

    lists.confirm('loud', lists.ask('loud', email, 'loud-1', 'en', 1000).id, 2000)
    lists.close()

    expect(await list.unsubscribe(email)).toBe(true)
  })

  it('tell the end of a broadcast once, with how it went', async () => {
    const file = join(await scratchDir('hooks-'), 'list.sqlite')
    const told: unknown[] = []
    const app = mailer({ from: 'a@example.com' })
    const list = app.list('news', { file, pace: { batch: 2, every: '50ms' }, onBroadcast: event => void told.push(event) })
    const lists = openLists(file)

    for (const index of [0, 1, 2]) {
      const email = `reader${index}@example.com`

      lists.confirm('news', lists.ask('news', email, `news-${email}`, 'en', 1000).id, 2000)
    }

    lists.close()

    const { id } = await list.send({ subject: 'News', text: 'Hello' })

    await drainUntil(app, () => told.length > 0)
    await app.drain()

    expect(told[0]).toMatchObject({ list: 'news', id, sent: 3, failed: 0 })
  })
})

describe('a contact form', () => {
  const input = { name: 'Ada', email: 'ada@example.com', message: 'Hello', topic: 'sales' }
  const ctx = { fail: (status: number, message: string) => ({ status, message }) } as never

  it('routes the mail by a `to` function of the input', async () => {
    const app = mailer({ from: 'a@example.com', queue: queued() })
    const [, handler] = contactForm(app, { to: given => (given as typeof input).topic === 'sales' ? 'sales@example.com' : 'help@example.com' })

    await handler(input, ctx)
    await app.drain()

    expect(outbox.to('sales@example.com')).toHaveLength(1)
    expect(outbox.to('help@example.com')).toHaveLength(0)
  })

  it('tells onSend the input and the queued id once the mail is queued, and survives a throwing one', async () => {
    const told: Record<string, unknown>[] = []
    const app = mailer({ from: 'a@example.com', queue: queued() })
    const [, handler] = contactForm(app, { to: 'team@example.com', onSend: event => void told.push(event) })
    const [, throwing] = contactForm(app, { to: 'team@example.com', onSend: () => {
      throw new Error('crm down')
    } })

    expect(await handler(input as never, ctx)).toBeUndefined()
    expect(await throwing(input as never, ctx)).toBeUndefined()
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ input: { name: 'Ada', email: 'ada@example.com' } })
    expect(typeof told[0]!.id).toBe('string')
    expect(outbox.mails).toHaveLength(0)
    expect(await app.drain()).toBe(2)
  })

  it('answers the refusal of a beforeSend as the form\'s own failure, queues nothing and tells no onSend', async () => {
    const told: unknown[] = []
    const app = mailer({ from: 'a@example.com', queue: queued(), beforeSend: () => false })
    const [, handler] = contactForm(app, { to: 'team@example.com', onSend: event => void told.push(event) })
    const error = await caught(handler(input, ctx))

    expect(statusOf(error)).toBe(403)
    expect(told).toHaveLength(0)
    expect(await app.drain()).toBe(0)
  })
})
