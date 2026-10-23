import type { NotificationStore } from '../src/server/notifications'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { invalidate } from '../src/runtime/cache'
import { setupStore } from '../src/server/app-store'
import { memoryNotifications, notifications, notificationStore, notify, safeNotificationUrl, sqliteNotifications } from '../src/server/notifications'
import { pgHandle } from '../src/server/pg-data'
import { pgNotifications } from '../src/server/pg-stores'
import { cleanUpAfterFile, pgDescribe, postgres } from './job-stores'
import { scratchDir } from './scratch'

cleanUpAfterFile()

const files: string[] = []

async function sqlitePath(): Promise<string> {
  const dir = await scratchDir('notifications-')

  files.push(dir)

  return join(dir, 'app.sqlite')
}

afterEach(async () => {
  setupStore(undefined)
  invalidate(() => true)
  await Promise.all(files.splice(0).map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('with no store configured', () => {
  it('keeps notifications in the process\'s memory, no schema or setup written', async () => {
    const note = await notify('ada', { title: 'Order shipped', url: '/orders/12' })

    expect(note).toMatchObject({ title: 'Order shipped', url: '/orders/12', read: false })
    expect(await notifications.list('ada')).toEqual([note])
    expect(await notifications.unread('ada')).toBe(1)
    expect(await notifications.erase('ada')).toBe(1)
  })
})

describe('the link of a notification', () => {
  it('keeps a path of the site and an http(s) URL', () => {
    expect(safeNotificationUrl('/orders/12?tab=a#b')).toBe('/orders/12?tab=a#b')
    expect(safeNotificationUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(safeNotificationUrl('http://example.com')).toBe('http://example.com')
  })

  it('drops every hostile one', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', '//evil.example/x', '/\\evil.example', '\\\\evil.example', 'vbscript:x', 'mailto:a@b.c', 'ftp://example.com', '/a b', '/a\nb', 'https://', ' https://example.com', '', 'orders/12', `/${'a'.repeat(2000)}`, 42, null, undefined])
      expect(safeNotificationUrl(url)).toBeUndefined()
  })

  it('stores a notification whose url was hostile with no link', async () => {
    const note = await notify('ada', { title: 'Look', url: 'javascript:alert(1)' })

    expect(note.url).toBeUndefined()
    expect((await notifications.list('ada'))[0]?.url).toBeUndefined()
  })
})

describe('the title of a notification', () => {
  it('is kept as the text it is, never changed to markup', async () => {
    const note = await notify('ada', { title: '<img src=x onerror=alert(1)> & co' })

    expect(note.title).toBe('<img src=x onerror=alert(1)> & co')
  })

  it('is 1 to 200 characters', async () => {
    await expect(notify('ada', { title: '   ' })).rejects.toThrow(RangeError)
    await expect(notify('ada', { title: 'a'.repeat(201) })).rejects.toThrow(RangeError)
    expect((await notify('ada', { title: 'a'.repeat(200) })).title).toHaveLength(200)
  })

  it('needs a user id', async () => {
    await expect(notify('', { title: 'x' })).rejects.toThrow(RangeError)
    await expect(notify('a'.repeat(201), { title: 'x' })).rejects.toThrow(RangeError)
  })
})

function storeCases(name: string, make: () => Promise<NotificationStore>): void {
  describe(name, () => {
    it('never shows one user\'s notifications to another', async () => {
      setupStore({ notifications: await make() })
      await notify('ada', { title: 'for Ada' })
      await notify('grace', { title: 'for Grace' })

      expect((await notifications.list('ada')).map(note => note.title)).toEqual(['for Ada'])
      expect((await notifications.list('grace')).map(note => note.title)).toEqual(['for Grace'])
      expect(await notifications.list('nobody')).toEqual([])

      const [mine] = await notifications.list('ada')

      expect(await notifications.markRead('grace', mine!.id)).toBe(false)
      expect(await notifications.unread('ada')).toBe(1)
      expect(await notifications.erase('grace')).toBe(1)
      expect(await notifications.unread('ada')).toBe(1)
    })

    it('lists the newest first and counts the unread', async () => {
      setupStore({ notifications: await make() })
      await notify('ada', { title: 'one' })
      await notify('ada', { title: 'two' })
      await notify('ada', { title: 'three' })

      expect((await notifications.list('ada')).map(note => note.title)).toEqual(['three', 'two', 'one'])
      expect((await notifications.list('ada', { limit: 2 })).map(note => note.title)).toEqual(['three', 'two'])
      expect(await notifications.unread('ada')).toBe(3)
    })

    it('marks one read, then all', async () => {
      setupStore({ notifications: await make() })

      const first = await notify('ada', { title: 'one' })

      await notify('ada', { title: 'two' })
      await notify('ada', { title: 'three' })

      expect(await notifications.markRead('ada', first.id)).toBe(true)
      expect(await notifications.markRead('ada', 'missing')).toBe(false)
      expect(await notifications.unread('ada')).toBe(2)
      expect((await notifications.list('ada')).find(note => note.id === first.id)?.read).toBe(true)
      expect(await notifications.markAllRead('ada')).toBe(2)
      expect(await notifications.unread('ada')).toBe(0)
      expect(await notifications.markAllRead('ada')).toBe(0)
      expect(await notifications.list('ada')).toHaveLength(3)
    })

    it('forgets a notification once it expired, and prunes the rows it still holds', async () => {
      const store = await make()
      const now = Date.now()

      setupStore({ notifications: store })
      await store.add('ada', { id: 'a', title: 'brief', at: now, expires: now + 1000 }, 200)
      await store.add('ada', { id: 'b', title: 'long', at: now + 1, expires: now + 100_000 }, 200)
      await store.add('grace', { id: 'c', title: 'other', at: now + 2, expires: now + 100_000 }, 200)
      expect(await store.list('ada', 5, now + 500)).toHaveLength(2)
      expect(await store.prune(now + 2000)).toBe(1)
      expect(await store.prune(now + 2000)).toBe(0)
      expect((await store.list('ada', 5, now + 2000)).map(note => note.title)).toEqual(['long'])
      expect(await store.unread('ada', now + 2000)).toBe(1)
      expect(await store.markRead('ada', 'a', now + 2000)).toBe(false)
      expect(await store.list('grace', 5, now + 2000)).toHaveLength(1)
    })

    it('takes the time a notification is kept from the keep option', async () => {
      const store = await make()
      const now = Date.now()

      setupStore({ notifications: store })
      await notify('ada', { title: 'an hour', keep: '1h' })
      expect(await store.list('ada', 5, now + 3_000_000)).toHaveLength(1)
      expect(await store.list('ada', 5, now + 3_700_000)).toHaveLength(0)
    })

    it('keeps 90 days by default', async () => {
      const store = await make()
      const now = Date.now()

      setupStore({ notifications: store })
      await notify('ada', { title: 'kept' })
      expect(await store.list('ada', 5, now + 89 * 86_400_000)).toHaveLength(1)
      expect(await store.list('ada', 5, now + 91 * 86_400_000)).toHaveLength(0)
    })

    it('erases a person\'s notifications and nobody else\'s', async () => {
      setupStore({ notifications: await make() })
      await notify('ada', { title: 'one' })
      await notify('ada', { title: 'two' })
      await notify('grace', { title: 'other' })

      expect(await notifications.erase('ada')).toBe(2)
      expect(await notifications.list('ada')).toEqual([])
      expect(await notifications.unread('ada')).toBe(0)
      expect(await notifications.inbox('ada')).toEqual({ unread: 0, items: [] })
      expect(await notifications.list('grace')).toHaveLength(1)
    })

    it('keeps a person\'s newest 200', async () => {
      setupStore({ notifications: await make() })

      for (let index = 0; index < 205; index++)
        await notify('ada', { title: `n${index}` })

      const all = await notifications.list('ada', { limit: 500 })

      expect(all).toHaveLength(200)
      expect(all[0]?.title).toBe('n204')
      expect(all.at(-1)?.title).toBe('n5')
    })
  })
}

storeCases('the memory store', async () => memoryNotifications())
storeCases('the SQLite store', async () => sqliteNotifications(await sqlitePath()))

describe('the SQLite store', () => {
  it('keeps notifications across a restart, and opens no file before it is used', async () => {
    const path = await sqlitePath()
    const first = sqliteNotifications(path)

    expect(await Bun.file(path).exists()).toBe(false)
    setupStore({ notifications: first })
    await notify('ada', { title: 'stays' })
    first.close?.()

    const second = sqliteNotifications(path)

    setupStore({ notifications: second })
    expect((await notifications.list('ada')).map(note => note.title)).toEqual(['stays'])
    second.close?.()
  })
})

describe('the inbox a page follows', () => {
  it('is dropped by every change, so a route reading it is read again', async () => {
    setupStore({ notifications: memoryNotifications() })
    expect(await notifications.inbox('ada')).toEqual({ unread: 0, items: [] })

    const note = await notify('ada', { title: 'new' })

    expect((await notifications.inbox('ada')).unread).toBe(1)
    await notifications.markRead('ada', note.id)
    expect((await notifications.inbox('ada')).unread).toBe(0)
    await notify('ada', { title: 'again' })
    await notifications.markAllRead('ada')
    expect((await notifications.inbox('ada')).unread).toBe(0)
    await notifications.erase('ada')
    expect((await notifications.inbox('ada')).items).toEqual([])
  })

  it('reads the app\'s store', async () => {
    const store = memoryNotifications()

    setupStore({ notifications: store })
    expect(notificationStore()).toBe(store)
  })
})

pgDescribe('Postgres', () => {
  storeCases('the Postgres store', async () => {
    const { sql } = await postgres()

    await sql.unsafe('DROP TABLE IF EXISTS kay_notifications')

    return pgNotifications(pgHandle(sql))
  })
})
