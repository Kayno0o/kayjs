import type { ListStore } from '../src/list-store'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { memoryJobs } from 'kay/server'
import { testSite } from 'kay/test'
import { createMailListTables, mailListTables, pgLists } from '../src/list-pg'
import { DELIVERY_TRIES, openLists } from '../src/list-store'
import { mailer } from '../src/mailer'
import { outbox } from '../src/outbox'

await testSite({ root: 'tests/fixture' })

// Skipped without a Postgres. A database of its own, as TEST_DATABASE_URL names a server whose user may create them, not one to write into.
const server = process.env.TEST_DATABASE_URL ?? ''
const database = `kay_mail_lists_${process.pid}`
const admin = server === '' ? undefined : new Bun.SQL(Object.assign(new URL(server), { pathname: '/postgres' }).href)
const url = server === '' ? '' : Object.assign(new URL(server), { pathname: `/${database}` }).href

if (admin !== undefined) {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${database}`)
}

const DAY = 24 * 3_600_000
let counter = 0
const run = Math.random().toString(36).slice(2, 8)
const pg = url === '' ? undefined : pgLists(url)

// A list name and addresses no other test or run shares, as Postgres keeps them between tests.
function names() {
  const id = `${run}${++counter}`

  return { list: `l${id}`, email: (name: string) => `${name}.${id}@example.com` }
}

const stores: [string, () => ListStore, boolean][] = [
  ['sqlite', () => openLists(':memory:'), true],
  ['postgres', () => pg!, url !== ''],
]

afterAll(async () => {
  await pg?.close()
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin?.close()
})

for (const [kind, open, enabled] of stores) {
  describe.skipIf(!enabled)(`the ${kind} list store`, () => {
    async function confirmed(store: ListStore, list: string, email: string, id = `id-${email}`, at = 2000) {
      await store.ask(list, email, id, 'en', 1000)
      await store.confirm(list, id, at)

      return id
    }

    it('keeps one row per address of a list, pending until confirmed', async () => {
      const store = open()
      const { list, email } = names()
      const first = await store.ask(list, email('ada'), 'one', 'fr', Date.now())
      const again = await store.ask(list, email('ada'), 'two', 'en', Date.now())

      expect(first).toMatchObject({ id: 'one', status: 'pending', locale: 'fr' })
      expect(again.id).toBe('one')
      expect(await store.count(list)).toBe(0)
      expect(await store.confirm(list, 'one')).toBe(true)
      expect(await store.confirm(list, 'one')).toBe(true)
      expect(await store.confirm(list, 'missing')).toBe(false)
      expect(await store.count(list)).toBe(1)
      expect((await store.subscribers(list)).map(row => row.email)).toEqual([email('ada')])
    })

    it('forgets a confirmation nobody clicked after 7 days, and a finished broadcast after 30', async () => {
      const store = open()
      const { list, email } = names()
      const old = Date.now() - 8 * DAY

      await store.ask(list, email('old'), 'old', 'en', old)
      await store.addBroadcast(`b${run}-old-${counter}`, list, '{}', old)
      await store.finish(`b${run}-old-${counter}`, old)
      await store.ask(list, email('new'), 'new', 'en', Date.now())
      expect(await store.confirm(list, 'old')).toBe(false)
      expect(await store.broadcast(`b${run}-old-${counter}`)).toBeDefined()

      await store.ask(list, email('newer'), 'newer', 'en', Date.now() + 31 * DAY)
      expect(await store.broadcast(`b${run}-old-${counter}`)).toBeUndefined()
    })

    it('claims a recipient once, gives it back for a retry up to its tries, then fails it', async () => {
      const store = open()
      const { list, email } = names()
      const id = await confirmed(store, list, email('ada'))
      const broadcast = `b${run}-claim-${counter}`

      await store.addBroadcast(broadcast, list, '{"subject":"x"}', 3000)

      const stored = (await store.broadcast(broadcast))!

      expect((await store.next(stored, 10)).map(row => row.id)).toEqual([id])
      expect(await store.progress(stored)).toEqual({ sent: 0, failed: 0, retrying: 0, unsure: 0, waiting: 1 })
      expect(await store.claim(broadcast, id)).toBe(true)
      expect(await store.claim(broadcast, id)).toBe(false)
      expect(await store.next(stored, 10)).toEqual([])
      expect(await store.progress(stored)).toMatchObject({ unsure: 1, waiting: 0 })

      for (let attempt = 1; attempt < DELIVERY_TRIES; attempt++) {
        await store.release(broadcast, id)
        expect(await store.progress(stored)).toMatchObject({ retrying: 1, unsure: 0 })
        expect((await store.next(stored, 10)).map(row => row.id)).toEqual([id])
        expect(await store.claim(broadcast, id)).toBe(true)
      }

      await store.release(broadcast, id)
      expect(await store.progress(stored)).toMatchObject({ failed: 1, retrying: 0 })
      expect(await store.claim(broadcast, id)).toBe(false)
    })

    it('lets one of several claims at once win', async () => {
      const store = open()
      const { list, email } = names()
      const id = await confirmed(store, list, email('ada'))
      const broadcast = `b${run}-race-${counter}`

      await store.addBroadcast(broadcast, list, '{}', 3000)

      const results = await Promise.all(Array.from({ length: 6 }, async () => store.claim(broadcast, id)))

      expect(results.filter(Boolean)).toHaveLength(1)
      await store.sent(broadcast, id)
      expect(await store.progress((await store.broadcast(broadcast))!)).toMatchObject({ sent: 1, unsure: 0 })
    })

    it('mails only whoever was confirmed before the broadcast, in a stable order and batch', async () => {
      const store = open()
      const { list, email } = names()
      const ids = [await confirmed(store, list, email('a'), 'a'), await confirmed(store, list, email('b'), 'b'), await confirmed(store, list, email('c'), 'c')]

      await store.addBroadcast(`b${run}-order-${counter}`, list, '{}', 3000)
      await confirmed(store, list, email('late'), 'late', 4000)

      const stored = (await store.broadcast(`b${run}-order-${counter}`))!

      expect((await store.next(stored, 2)).map(row => row.id)).toEqual(ids.slice(0, 2))
      expect((await store.next(stored, 10)).map(row => row.id)).toEqual(ids)
    })

    it('takes a removed subscriber\'s deliveries with it, and refuses it a claim', async () => {
      const store = open()
      const { list, email } = names()
      const id = await confirmed(store, list, email('ada'))
      const gone = await confirmed(store, list, email('bob'))
      const broadcast = `b${run}-remove-${counter}`

      await store.addBroadcast(broadcast, list, '{}', 3000)
      expect(await store.claim(broadcast, id)).toBe(true)
      expect(await store.remove(list, id)).toBe(true)
      expect(await store.remove(list, id)).toBe(false)
      expect(await store.progress((await store.broadcast(broadcast))!)).toMatchObject({ unsure: 0, waiting: 1 })
      expect(await store.removeEmail(list, email('bob'))).toBe(true)
      expect(await store.removeEmail(list, email('bob'))).toBe(false)
      expect(await store.claim(broadcast, gone)).toBe(false)
    })

    it('erases an address from every list with its deliveries, whatever its state', async () => {
      const store = open()
      const { list, email } = names()
      const other = `${list}x`
      const id = await confirmed(store, list, email('ada'))

      await store.ask(other, email('ada'), 'pending-one', 'en')
      await store.ask(list, email('bob'), 'bob', 'en')

      const broadcast = `b${run}-erase-${counter}`

      await store.addBroadcast(broadcast, list, '{}', 3000)
      expect(await store.claim(broadcast, id)).toBe(true)
      expect(await store.erase(email('ada'))).toBe(2)
      expect(await store.erase(email('ada'))).toBe(0)
      expect(await store.claim(broadcast, id)).toBe(false)
      expect(await store.progress((await store.broadcast(broadcast))!)).toMatchObject({ unsure: 0 })
      expect((await store.ask(list, email('bob'), 'other', 'en')).id).toBe('bob')
    })

    it('lists every row of an address, pending ones too', async () => {
      const store = open()
      const { list, email } = names()
      const other = `${list}x`

      await confirmed(store, list, email('ada'))
      await store.ask(other, email('ada'), 'pending-two', 'en', 3000)
      await confirmed(store, list, email('bob'))
      expect((await store.forEmail(email('ada'))).map(row => [row.list, row.status])).toEqual([[list, 'confirmed'], [other, 'pending']])
      expect(await store.forEmail(email('nobody'))).toEqual([])
    })

    it('finishes a broadcast once', async () => {
      const store = open()
      const { list } = names()
      const broadcast = `b${run}-finish-${counter}`

      await store.addBroadcast(broadcast, list, '{}', 3000)
      await store.finish(broadcast, 5000)
      await store.finish(broadcast, 9000)
      expect((await store.broadcast(broadcast))?.finishedAt).toBe(5000)
    })
  })
}

describe.skipIf(url === '')('a list on Postgres', () => {
  it('creates its three tables, and createMailListTables is safe to repeat', async () => {
    const db = new Bun.SQL(url)

    try {
      await pg!.count('anything')
      await createMailListTables(db)
      await createMailListTables(db)

      const [found] = await db.unsafe<{ present: boolean }[]>(`SELECT ${mailListTables.map(name => `to_regclass('${name}') IS NOT NULL`).join(' AND ')} AS present`)

      expect(found!.present).toBe(true)
    }
    finally {
      await db.close()
    }
  })

  it('sends a broadcast through the mailer, a batch at a time, and erases a person from it', async () => {
    const { list, email } = names()
    const store = pgLists(url)
    const app = mailer({ from: 'a@fixture.test', queue: { store: memoryJobs(), name: `pg${run}` } })
    const news = app.list(list, { store, pace: { batch: 2, every: '50ms' } })
    const addresses = ['a', 'b', 'c'].map(email)

    outbox.clear()

    try {
      for (const address of addresses) {
        const subscriber = await store.ask(list, address, `s-${address}`, 'en', 1000)

        await store.confirm(list, subscriber.id, 2000)
      }

      const { id, recipients } = await news.send({ subject: 'News', text: 'Hello' })

      expect(recipients).toBe(3)

      for (let round = 0; round < 40 && !(await news.status(id))?.done; round++) {
        await app.drain()
        await Bun.sleep(60)
      }

      expect(await news.status(id)).toMatchObject({ done: true, sent: 3, waiting: 0, failed: 0 })

      for (const address of addresses)
        expect(outbox.to(address)).toHaveLength(1)

      expect(await app.erase(addresses[0]!.toUpperCase())).toBe(1)
      expect((await news.subscribers()).map(row => row.email)).toEqual(addresses.slice(1))
      expect(await app.subscriptions(addresses[0]!)).toEqual([])
      expect(await app.subscriptions(addresses[1]!.toUpperCase())).toMatchObject([{ list: expect.any(String), status: 'confirmed', confirmedAt: expect.any(Date) }])
      expect(await news.unsubscribe(addresses[1]!)).toBe(true)
      expect(await news.count()).toBe(1)
    }
    finally {
      outbox.clear()
      await store.close()
    }
  })

  it('makes a claim wait for an erase holding the subscriber, then refuse it', async () => {
    const db = new Bun.SQL(url)

    try {
      const { list, email } = names()
      const broadcast = `b${run}-erace-${counter}`
      const address = email('r')

      await pg!.addBroadcast(broadcast, list, '{}', 3000)

      const subscriber = await pg!.ask(list, address, `r-${run}`, 'en')

      await pg!.confirm(list, subscriber.id, 2000)

      let settled = false
      let claim: Promise<boolean> | undefined

      await db.begin(async (tx) => {
        await tx.unsafe('SELECT id FROM kay_mail_subscribers WHERE id = $1 FOR UPDATE', [subscriber.id])
        claim = (async () => {
          try {
            return await pg!.claim(broadcast, subscriber.id)
          }
          finally {
            settled = true
          }
        })()
        await Bun.sleep(150)
        expect(settled).toBe(false)
        await tx.unsafe('DELETE FROM kay_mail_subscribers WHERE id = $1', [subscriber.id])
      })

      expect(await claim).toBe(false)
      expect(await db.unsafe<unknown[]>('SELECT 1 FROM kay_mail_deliveries WHERE subscriber = $1', [subscriber.id])).toHaveLength(0)
    }
    finally {
      await db.close()
    }
  })

  it('takes a delivery claimed before an erase away with the subscriber', async () => {
    const { list, email } = names()
    const broadcast = `b${run}-eclaim-${counter}`
    const address = email('c')

    await pg!.addBroadcast(broadcast, list, '{}', 3000)

    const subscriber = await pg!.ask(list, address, `c-${run}`, 'en')

    await pg!.confirm(list, subscriber.id, 2000)
    expect(await pg!.claim(broadcast, subscriber.id)).toBe(true)
    expect(await pg!.erase(address)).toBe(1)
    expect(await pg!.progress((await pg!.broadcast(broadcast))!)).toMatchObject({ unsure: 0 })
  })

  it('is the store of the lists of a mailer, its links and its erase when given as listStore', async () => {
    const { list, email } = names()
    const store = pgLists(url)
    const address = email('m')

    try {
      const subscriber = await store.ask(list, address, `m-${run}`, 'en')

      await store.confirm(list, subscriber.id, 2000)

      const app = mailer({ from: 'a@fixture.test', listStore: store })

      // A link of a list this mailer has not declared finds the store, and so does an erase.
      expect(await app.list(list).count()).toBe(1)

      const other = mailer({ from: 'a@fixture.test', listStore: store })

      expect(await other.erase(address)).toBe(1)
      expect(await store.count(list)).toBe(0)
    }
    finally {
      await store.close()
    }
  })

  it('refuses a store given with a file', () => {
    const app = mailer({ from: 'a@fixture.test' })

    expect(() => app.list('both', { store: pg!, file: ':memory:' })).toThrow('a store or a file')
  })
})
