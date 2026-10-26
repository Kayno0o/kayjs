import type { JobStore } from 'kay/server'
import type { ListStore } from '../src/list-store'
import type { Mail, Transport } from '../src/types'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { memoryJobs } from 'kay/server'
import { scratchDir, testSite } from 'kay/test'
import { openLists } from '../src/list-store'
import { mailer } from '../src/mailer'
import { isOwnMessageId } from '../src/message-id'
import { outbox } from '../src/outbox'
import { untilHolds } from './until'

await testSite({ root: 'tests/fixture' })

const PACE = { batch: 2, every: '50ms' } as const
let file = ''
let counter = 0

beforeEach(async () => {
  file = join(await scratchDir('list-'), `list-${++counter}.sqlite`)
  outbox.clear()
})

afterEach(() => outbox.clear())

// Subscribers confirmed straight in the file, as the confirmation links would have.
function seed(count: number, name = 'news'): string[] {
  const lists = openLists(file)
  const emails = Array.from({ length: count }, (_, index) => `reader${index}@example.com`)

  for (const email of emails) {
    const { id } = lists.ask(name, email, `${name}-${email}`, 'en', 1000)

    lists.confirm(name, id, 2000)
  }

  lists.close()

  return emails
}

function sentTo(email: string): Mail[] {
  return outbox.to(email)
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms)
}

// Drains until the broadcast is done, as a running server's worker would.
async function finish(app: ReturnType<typeof mailer>, id: string, name = 'news'): Promise<void> {
  for (let round = 0; round < 40; round++) {
    await app.drain()

    if ((await app.list(name).status(id))?.done)
      return

    await sleep(60)
  }

  throw new Error('the broadcast did not finish')
}

describe('a broadcast', () => {
  it('goes out a batch at a time, each subscriber getting one mail with their own unsubscribe link', async () => {
    const emails = seed(5)
    const app = mailer({ from: 'a@fixture.test' })
    const list = app.list('news', { file, pace: PACE })
    const { id, recipients } = await list.send({ subject: 'News', text: 'Hello' })

    expect(recipients).toBe(5)

    await app.drain()
    expect(outbox.mails).toHaveLength(2)
    expect(await list.status(id)).toMatchObject({ done: false, sent: 2, waiting: 3 })

    await finish(app, id)

    expect(await list.status(id)).toMatchObject({ done: true, sent: 5, waiting: 0, failed: 0, unsure: 0 })

    const links = new Set<string>()
    const ids = new Set<string>()

    for (const email of emails) {
      const [mail, ...others] = sentTo(email)

      expect(others).toHaveLength(0)
      expect(mail!.to).toEqual([email])
      links.add(mail!.headers['List-Unsubscribe']!)
      // A shared id would make the copies one message to a client, so each has its own.
      ids.add(mail!.headers['Message-ID']!)
    }

    expect(links.size).toBe(5)
    expect(ids.size).toBe(5)
    expect([...ids].every(id => isOwnMessageId(id))).toBe(true)
  })

  it('resumes after a restart where it stopped, mailing nobody twice', async () => {
    const emails = seed(5)
    const jobs = memoryJobs()
    const before = mailer({ from: 'a@fixture.test', queue: { store: jobs } })
    const { id } = await before.list('news', { file, pace: PACE }).send({ subject: 'News', text: 'Hello' })

    await before.drain()
    expect(outbox.mails).toHaveLength(2)

    // A new process: another mailer on the same file and the same job store.
    const after = mailer({ from: 'a@fixture.test', queue: { store: jobs } })

    after.list('news', { file, pace: PACE })
    await finish(after, id)

    expect(outbox.mails).toHaveLength(5)

    for (const email of emails)
      expect(sentTo(email)).toHaveLength(1)
  })

  it('does not mail again a recipient claimed by a process that died inside the send, and says so', async () => {
    const emails = seed(3)
    const app = mailer({ from: 'a@fixture.test' })
    const list = app.list('news', { file, pace: { batch: 5, every: '50ms' } })
    const { id } = await list.send({ subject: 'News', text: 'Hello' })
    const lists = openLists(file)
    const stranded = lists.next(lists.broadcast(id)!, 1)[0]!

    // What a process dying between the claim and the end of the send leaves.
    expect(lists.claim(id, stranded.id)).toBe(true)
    lists.close()

    await finish(app, id)

    expect(sentTo(stranded.email)).toHaveLength(0)
    expect(emails.filter(email => email !== stranded.email).every(email => sentTo(email).length === 1)).toBe(true)
    expect(await list.status(id)).toMatchObject({ done: true, sent: 2, unsure: 1 })
  })

  it('tries a recipient the transport refuses three times, then goes on without it', async () => {
    const emails = seed(3)
    const attempts = new Map<string, number>()
    const transport: Transport = {
      send: async (mail) => {
        const to = mail.to[0] as string

        attempts.set(to, (attempts.get(to) ?? 0) + 1)

        if (to === emails[1])
          throw new Error('mailbox full')

        return outbox.send(mail)
      },
    }

    const app = mailer({ from: 'a@fixture.test', transport })
    const list = app.list('news', { file, pace: { batch: 5, every: '50ms' } })
    const { id } = await list.send({ subject: 'News', text: 'Hello' })

    await finish(app, id)

    expect(attempts.get(emails[1]!)).toBe(3)
    expect(attempts.get(emails[0]!)).toBe(1)
    expect(await list.status(id)).toMatchObject({ done: true, sent: 2, failed: 1 })
  })

  it('skips a subscriber who unsubscribed or was erased during the send, and one who joined after', async () => {
    const emails = seed(4)
    const app = mailer({ from: 'a@fixture.test' })
    const list = app.list('news', { file, pace: PACE })
    const { id } = await list.send({ subject: 'News', text: 'Hello' })

    await app.drain()

    const sent = new Set(outbox.mails.map(mail => (mail.to[0] as { address?: string } | string) as string))
    const waiting = emails.filter(email => !sent.has(email))

    expect(waiting).toHaveLength(2)
    await list.unsubscribe(waiting[0]!)
    await app.erase(waiting[1]!)

    const lists = openLists(file)

    lists.confirm('news', lists.ask('news', 'late@example.com', 'late', 'en', Date.now() + 10_000).id, Date.now() + 10_000)
    lists.close()

    await finish(app, id)

    expect(sentTo(waiting[0]!)).toHaveLength(0)
    expect(sentTo(waiting[1]!)).toHaveLength(0)
    expect(sentTo('late@example.com')).toHaveLength(0)
    expect(outbox.mails).toHaveLength(2)
  })

  it('keeps the lists apart', async () => {
    seed(2, 'news')
    seed(1, 'other')

    const app = mailer({ from: 'a@fixture.test' })
    const other = app.list('other', { file })

    app.list('news', { file })

    const { id, recipients } = await other.send({ subject: 'Other', text: 'x' })

    await finish(app, id, 'other')
    expect(recipients).toBe(1)
    expect(outbox.mails).toHaveLength(1)
    expect(await app.list('news').status(id)).toBeUndefined()
  })

  it('refuses attachments, and a pace that is no batch', async () => {
    const app = mailer({ from: 'a@fixture.test' })

    await expect(app.list('news', { file }).send({ subject: 'x', text: 'x', attachments: [] } as never)).rejects.toThrow('takes no attachments')
    expect(() => app.list('paced', { file, pace: { batch: 0 } })).toThrow('pace.batch')
  })
})

describe('a store failing after a mail left', () => {
  it('leaves the delivery claimed instead of giving it back for another send', async () => {
    const emails = seed(1)
    const inner = openLists(file)
    const store: ListStore = { ...inner, sent: () => {
      throw new Error('the store went away')
    } }
    const app = mailer({ from: 'a@fixture.test', queue: { store: memoryJobs() } })
    const list = app.list('news', { store, pace: PACE })
    const { id } = await list.send({ subject: 'News', text: 'Hello' })

    await app.drain()

    expect(sentTo(emails[0]!)).toHaveLength(1)
    expect(await list.status(id)).toMatchObject({ done: false, sent: 0, unsure: 1, retrying: 0, waiting: 0 })
    expect(await inner.next((await inner.broadcast(id))!, 10)).toEqual([])
  })
})

describe('the list queue', () => {
  // A job store counting the looks each queue makes at it.
  function watched(): { store: JobStore, looks: Map<string, number> } {
    const inner = memoryJobs()
    const looks = new Map<string, number>()

    return { looks, store: { ...inner, claim: async (queue, now, until) => {
      looks.set(queue, (looks.get(queue) ?? 0) + 1)

      return inner.claim(queue, now, until)
    } } }
  }

  it('starts no worker until a list is declared', async () => {
    const { store, looks } = watched()
    const app = mailer({ from: 'a@fixture.test', queue: { store, name: 'watched' } })

    app.listen(0)

    try {
      // The queue has looked at its store, and the list queue, which no list asked for yet, has had time to start if it would.
      await untilHolds(() => (looks.get('watched') ?? 0) > 0)
      await sleep(150)
      expect(looks.get('watched')).toBeGreaterThan(0)
      expect(looks.get('watched-list')).toBeUndefined()

      app.list('news', { file })
      await untilHolds(() => (looks.get('watched-list') ?? 0) > 0)
      expect(looks.get('watched-list')).toBeGreaterThan(0)
    }
    finally {
      await app.stop()
    }
  })

  it('starts at once when a list is declared before the server', async () => {
    const { store, looks } = watched()
    const app = mailer({ from: 'a@fixture.test', queue: { store, name: 'early' } })

    app.list('news', { file })
    app.listen(0)

    try {
      await untilHolds(() => (looks.get('early-list') ?? 0) > 0)
      expect(looks.get('early-list')).toBeGreaterThan(0)
    }
    finally {
      await app.stop()
    }
  })
})
