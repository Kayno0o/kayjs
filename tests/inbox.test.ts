import type { NotificationStore } from '../src/server/notifications'
import type { TestSite } from '../src/test'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { ui } from '../packages/ui/src/extension'
import { invalidate } from '../src/runtime/cache'
import { setupStore } from '../src/server/app-store'
import { memoryNotifications, notifications, notify } from '../src/server/notifications'
import { testSite } from '../src/test'
import { visitor, who } from './fixtures/inbox/lib/who'

const ROOT = 'tests/fixtures/inbox'
const ADA = { 'x-user': 'ada' }
const GRACE = { 'x-user': 'grace' }

interface Inbox {
  unread: number
  items: { id: string, title: string, url?: string, read: boolean }[]
}

const sites = new Map<string, Promise<TestSite>>()

async function app(base: string) {
  let held = sites.get(base)

  if (!held) {
    held = testSite({ root: ROOT, extensions: [ui(), who()], plugins: [tailwind], islands: false, base: base || undefined })
    sites.set(base, held)
  }

  return held
}

async function get(path: string, headers: Record<string, string> = {}, base = '') {
  const response = await (await app(base)).fetch(path, { headers })

  return { status: response.status, text: await response.text(), headers: response.headers }
}

async function inbox(headers: Record<string, string>, base = ''): Promise<Inbox> {
  const answer = await get('/_kay/ui/inbox', headers, base)

  return JSON.parse(answer.text) as Inbox
}

async function post(body: unknown, headers: Record<string, string>, base = '') {
  const response = await (await app(base)).fetch('/_kay/ui/inbox/read', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  return { status: response.status, text: await response.text() }
}

let store: NotificationStore

beforeEach(() => {
  visitor.name = undefined
  store = memoryNotifications()
  setupStore({ notifications: store })
  invalidate(() => true)
})

afterAll(async () => {
  setupStore(undefined)
  await Promise.all([...sites.values()].map(async site => (await site).close()))
})

describe('the Bell on a page', () => {
  for (const base of ['', '/repo']) {
    it(`draws nothing for a signed-out visitor and the bell for a signed-in one, with base ${base || 'unset'}`, async () => {
      const out = await get('/', {}, base)
      const signedIn = await get('/', ADA, base)

      expect(out.status).toBe(200)
      expect(out.text).not.toContain('kui-bell')
      expect(out.text).not.toContain('aria-label="Notifications"')
      expect(signedIn.text).toContain('kui-bell')
      expect(signedIn.text).toContain('Notifications')
    })
  }

  it('is the visitor\'s own page: private, never shared', async () => {
    const out = await get('/', ADA)

    expect(out.headers.get('cache-control')).toContain('private')
  })

  it('ships no part of the bell to a page that has none', async () => {
    expect((await get('/plain', ADA)).text).not.toContain('kui-bell')
  })
})

describe('the inbox route', () => {
  it('refuses a request nobody is signed in for', async () => {
    expect((await get('/_kay/ui/inbox')).status).toBe(401)
    expect((await post({}, {})).status).toBe(401)
  })

  it('answers each user their own notifications and never another\'s', async () => {
    await notify('ada', { title: 'for Ada', url: '/orders/1' })
    await notify('grace', { title: 'for Grace' })

    expect((await inbox(ADA)).items.map(note => note.title)).toEqual(['for Ada'])
    expect((await inbox(GRACE)).items.map(note => note.title)).toEqual(['for Grace'])
    expect((await inbox(ADA)).unread).toBe(1)
  })

  it('reads the user from the request, not from anything the request says about itself', async () => {
    await notify('grace', { title: 'for Grace' })

    const forged = await get('/_kay/ui/inbox?user=grace', ADA)

    expect((JSON.parse(forged.text) as Inbox).items).toEqual([])

    const [note] = await notifications.list('grace')
    const marked = await post({ id: note!.id, user: 'grace' }, ADA)

    expect(marked.status).toBe(200)
    expect(await notifications.unread('grace')).toBe(1)
  })

  it('answers under the base', async () => {
    await notify('ada', { title: 'under base' })
    expect((await inbox(ADA, '/repo')).items[0]?.title).toBe('under base')
  })

  it('marks one read, then all', async () => {
    const first = await notify('ada', { title: 'one' })

    await notify('ada', { title: 'two' })
    await notify('ada', { title: 'three' })

    const one = await post({ id: first.id }, ADA)

    expect((JSON.parse(one.text) as Inbox).unread).toBe(2)
    expect((await inbox(ADA)).items.find(note => note.id === first.id)?.read).toBe(true)

    const all = await post({}, ADA)

    expect((JSON.parse(all.text) as Inbox).unread).toBe(0)
  })

  it('links only a path of the site or an http(s) URL, even from a store that kept a hostile one', async () => {
    const now = Date.now()

    await store.add('ada', { id: 'a', title: 'js', url: 'javascript:alert(1)', at: now, expires: now + 100_000 }, 200)
    await store.add('ada', { id: 'b', title: 'proto', url: '//evil.example/x', at: now + 1, expires: now + 100_000 }, 200)
    await store.add('ada', { id: 'c', title: 'ok', url: '/orders/2', at: now + 2, expires: now + 100_000 }, 200)
    invalidate(() => true)

    const items = (await inbox(ADA)).items

    expect(items.map(note => [note.title, note.url])).toEqual([['ok', '/orders/2'], ['proto', undefined], ['js', undefined]])
  })

  it('sends a title as the text it is', async () => {
    await notify('ada', { title: '<b>bold</b> & "quoted"' })
    expect((await inbox(ADA)).items[0]?.title).toBe('<b>bold</b> & "quoted"')
  })

  it('shows nothing once the person was erased', async () => {
    await notify('ada', { title: 'one' })
    expect((await inbox(ADA)).unread).toBe(1)
    await notifications.erase('ada')
    expect(await inbox(ADA)).toEqual({ unread: 0, items: [] })
  })

  it('asks for the live proof so a tab hears of a change', async () => {
    await notify('ada', { title: 'one' })
    expect((await get('/_kay/ui/inbox', ADA)).headers.get('x-kay-live')).toBeTruthy()
  })
})
