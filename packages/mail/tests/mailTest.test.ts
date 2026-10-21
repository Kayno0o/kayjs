import type { Action } from 'kay'
import { describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { mailTest } from '../src/test'

interface Answers { name: string, email: string, topic: 'quote' | 'other', message: string }

const { contact } = await import(`${import.meta.dir}/fixture/src/routes/contact.kay`) as { contact: Action<Answers, unknown> }

const fields: Answers = { name: 'Ada Lovelace', email: 'ada@example.com', topic: 'quote', message: 'Hello,\nI would like a quote.' }

const site = await testSite({ root: 'tests/fixture' })
const mail = mailTest(site)

describe('mailTest', () => {
  it('reads the mails the site sent', async () => {
    expect(mail.mails).toHaveLength(0)

    await site.call(contact, fields)

    expect(mail.last()?.subject).toBe('Message from Ada Lovelace')
    expect(mail.to('team@fixture.test')).toHaveLength(1)
    expect(mail.find(mail.last()!.id)).toBe(mail.last())
  })

  it('starts the next test with an empty outbox, cleared by itself', async () => {
    expect(mail.mails).toHaveLength(0)
    expect(mail.last()).toBeUndefined()

    await site.call(contact, fields)

    expect(mail.mails).toHaveLength(1)
  })

  it('waits for a mail the app enqueued, running the site\'s queues', async () => {
    const waited = mail.waitFor('team@fixture.test', { timeout: 1 })

    await site.call(contact, fields)

    expect((await waited).subject).toBe('Message from Ada Lovelace')
  })

  it('names the mails the outbox holds when none came', async () => {
    await expect(mail.waitFor('nobody@fixture.test', { timeout: 0.05 })).rejects.toThrow('no mail to nobody@fixture.test')
  })
})
