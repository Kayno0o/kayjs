import type { GuardContext } from 'kay'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import * as server from 'kay/server'
import { stamps } from '../src/authors'
import { isRestrained } from '../src/publishing'
import { checkRoles } from '../src/roles'
import { configure } from '../src/settings'

class Denied {
  constructor(readonly status: number, readonly message?: string) {}
}

type Data = Record<string, unknown>

// What the collections hold: `<collection>/<slug>`, written by `author`.
const stored = new Map<string, Data>()
// The entries that name each `<collection>/<slug>` in a reference field.
const referrers = new Map<string, { collection: string, data: Data }[]>()
const trash = new Map<string, Data>()
// The collections that fail to read.
const unreadable = new Set<string>()

function reset(): void {
  stored.clear()
  referrers.clear()
  trash.clear()
  unreadable.clear()
  stored.set('posts/mine', { title: 'Mine', draft: false, author: 'u1' })
  stored.set('posts/theirs', { title: 'Theirs', draft: false, author: 'u2' })
  stored.set('posts/orphan', { title: 'Orphan', draft: false })
  stored.set('posts/blank', { title: 'Blank', draft: false, author: '' })
  stored.set('pages/about', { title: 'About', draft: false, author: 'u1' })
  trash.set('posts/t-mine', { title: 'Mine', author: 'u1' })
  trash.set('posts/t-theirs', { title: 'Theirs', author: 'u2' })
}

void mock.module('kay/server', () => ({ ...server, editRequested: () => false, editedEntry: () => false }))
void mock.module('../src/store', () => ({
  collectionNamed: async (name: string) => ({ name, draftField: 'draft', publishField: undefined, unpublishField: undefined }),
  heldDate: () => '9999-12-31T00:00:00.000Z',
  entryScreen: async ({ collection, slug, locale }: { collection: string, slug: string, locale?: string }) => ({ collection: { problem: unreadable.has(collection) ? 'failed' : undefined }, entry: (locale === undefined || locale === 'en') && stored.has(`${collection}/${slug}`) ? { data: stored.get(`${collection}/${slug}`) } : undefined }),
}))
void mock.module('../src/references', () => ({
  referrersWith: async (collection: string, slugs: string[]) => new Map(slugs.map(slug => [slug, (referrers.get(`${collection}/${slug}`) ?? []).map(({ collection: name, data }) => ({ collection: { name }, entry: { data }, label: '' }))])),
}))
void mock.module('../src/trash', () => ({
  trashed: async (collection: string, id: string) => trash.has(`${collection}/${id}`) ? { data: trash.get(`${collection}/${id}`) } : undefined,
}))

const { default: devApi } = await import('../src/api/dev')

Object.assign(devApi, { [Symbol.for('kay.api')]: '/_kay/cms/dev' })

const { default: apiGuard } = await import('../src/api/_guard')

interface Asks { method?: string, path: string, body?: unknown, user?: { id: string, roles: string[] } | null }

function ask({ method = 'POST', path, body, user }: Asks): GuardContext {
  const url = new URL(`http://site.test/_kay/cms${path}`)

  return {
    request: new Request(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) }),
    url,
    cookies: new Bun.CookieMap(''),
    locals: user === undefined || user === null
      ? {}
      : { auth: {
        bareUser: async () => user,
        isGranted: (role: string, who: { roles: string[] }) => who.roles.includes(role),
      } },
    deny: (status: number, message?: string) => {
      throw new Denied(status, message)
    },
  } as unknown as GuardContext
}

async function statusOf(ctx: GuardContext): Promise<number> {
  try {
    await apiGuard(ctx)

    return 200
  }
  catch (error) {
    if (error instanceof Denied)
      return error.status

    throw error
  }
}

const me = { id: 'u1', roles: ['blogger'] }

function configureRoles(roles: Parameters<typeof configure>[0]['roles']): void {
  configure({ guard: async ({ locals }) => {
    if (await (locals as { auth: { bareUser: () => Promise<unknown> } }).auth.bareUser() === null)
      throw new Denied(401, 'Sign in')
  }, roles })
}

// Every route that writes an entry, as the editor and the list call it.
const ENTRY_ROUTES = [
  ['POST', 'save', (c: string, s: string) => `/entries/${c}/${s}`],
  ['POST', 'publish', (c: string, s: string) => `/entries/${c}/${s}/publish`],
  ['POST', 'unpublish', (c: string, s: string) => `/entries/${c}/${s}/unpublish`],
  ['POST', 'share', (c: string, s: string) => `/entries/${c}/${s}/share`],
  ['POST', 'submit', (c: string, s: string) => `/entries/${c}/${s}/submit`],
  ['POST', 'approve', (c: string, s: string) => `/entries/${c}/${s}/approve`],
  ['POST', 'send-back', (c: string, s: string) => `/entries/${c}/${s}/send-back`],
  ['POST', 'duplicate', (c: string, s: string) => `/entries/${c}/${s}/duplicate`],
  ['POST', 'rename', (c: string, s: string) => `/entries/${c}/${s}/rename`],
  ['DELETE', 'delete', (c: string, s: string) => `/entries/${c}/${s}`],
  ['POST', 'newsletter preview', (c: string, s: string) => `/newsletter/${c}/${s}/preview`],
  ['POST', 'newsletter send', (c: string, s: string) => `/newsletter/${c}/${s}/send`],
  ['POST', 'history restore', (c: string, s: string) => `/history/${c}/${s}/restore`],
  ['POST', 'history erase', (c: string, s: string) => `/history/${c}/${s}/erase`],
] as const

const ALL = ['publish', 'review', 'delete', 'upload', 'redirects'] as const

async function send(user: { id: string, roles: string[] }, method: string, path: string, body?: unknown): Promise<number> {
  return statusOf(ask({ method, path, user, body: body ?? (method === 'DELETE' ? undefined : { data: { title: 'x', draft: false }, at: 1 }) }))
}

beforeEach(reset)

describe('a role limited to collections', () => {
  beforeEach(() => configureRoles({ blogger: { collections: ['posts'], actions: [...ALL] }, reader: [] }))

  test('does every action of the entry in a collection it reaches, and none in another, through each route', async () => {
    for (const [method, name, path] of ENTRY_ROUTES) {
      expect(await send(me, method, path('posts', 'theirs')), `${name} in posts`).toBe(200)
      expect(await send(me, method, path('pages', 'about')), `${name} in pages`).toBe(403)
    }
  })

  test('reads, lists and uploads only in its collections, the choices of a reference field aside', async () => {
    expect(await send(me, 'GET', '/entries/posts/theirs')).toBe(200)
    expect(await send(me, 'GET', '/entries/pages/about')).toBe(403)
    expect(await send(me, 'GET', '/slugs/posts')).toBe(200)
    expect(await send(me, 'GET', '/slugs/pages')).toBe(403)
    expect(await send(me, 'GET', '/referrers/pages?slugs=[]')).toBe(403)
    expect(await send(me, 'GET', '/files/posts')).toBe(200)
    expect(await send(me, 'GET', '/files/pages')).toBe(403)
    expect(await send(me, 'POST', '/files/posts')).toBe(200)
    expect(await send(me, 'POST', '/files/pages')).toBe(403)
    expect(await send(me, 'GET', '/markdown/image?collection=pages&slug=a&path=b.png')).toBe(403)
    expect(await send(me, 'GET', '/entries/pages')).toBe(200)
    expect(await send(me, 'GET', '/files/rules')).toBe(200)
  })

  test('makes a new entry and reorders a collection it reaches', async () => {
    expect(await send(me, 'POST', '/entries/posts/fresh', { data: { title: 'New' }, create: true })).toBe(200)
    expect(await send(me, 'POST', '/entries/pages/fresh', { data: { title: 'New' }, create: true })).toBe(403)
    expect(await send(me, 'POST', '/entries/posts/theirs/move?direction=up')).toBe(200)
    expect(await send(me, 'POST', '/entries/pages/about/move?direction=up')).toBe(403)
  })

  test('restores from the trash only in its collections', async () => {
    expect(await send(me, 'POST', '/trash/posts/t-theirs/restore')).toBe(200)
    expect(await send(me, 'POST', '/trash/pages/anything/restore')).toBe(403)
  })

  test('has no standing on what belongs to the site, which only an unlimited role holding the action reaches', async () => {
    for (const [method, path] of [['POST', '/redirects'], ['GET', '/redirects/paths?q=a'], ['POST', '/files/media/rename'], ['POST', '/files/unused/delete'], ['POST', '/history/forget-editor']] as const)
      expect(await send(me, method, path), path).toBe(403)

    configureRoles({ blogger: { collections: ['posts'], actions: [...ALL] }, admin: [...ALL] })

    for (const [method, path] of [['POST', '/redirects'], ['GET', '/redirects/paths?q=a'], ['POST', '/files/media/rename'], ['POST', '/files/unused/delete'], ['POST', '/history/forget-editor']] as const)
      expect(await send({ id: 'u1', roles: ['blogger', 'admin'] }, method, path), path).toBe(200)
  })

  test('holds only the actions it lists, within its collections', async () => {
    configureRoles({ blogger: { collections: ['posts'], actions: ['publish'] } })

    expect(await send(me, 'POST', '/entries/posts/theirs/publish')).toBe(200)
    expect(await send(me, 'DELETE', '/entries/posts/theirs')).toBe(403)
    expect(await send(me, 'POST', '/entries/posts/theirs/rename')).toBe(403)
    expect(await send(me, 'POST', '/files/posts')).toBe(403)
    expect(await send(me, 'POST', '/entries/posts/theirs')).toBe(200)
  })

  test('a person with another role reaches what that role reaches', async () => {
    configureRoles({ blogger: { collections: ['posts'], actions: [...ALL] }, pager: { collections: ['pages'] } })

    const both = { id: 'u1', roles: ['blogger', 'pager'] }

    expect(await send(both, 'POST', '/entries/pages/about')).toBe(200)
    expect(await send(both, 'POST', '/entries/pages/about/publish')).toBe(403)
    expect(await send(both, 'POST', '/entries/posts/theirs/publish')).toBe(200)
  })

  test('a person holding no listed role reaches nothing once a role is limited, as no scope may be walked around', async () => {
    const stranger = { id: 'u9', roles: ['stranger'] }

    expect(await send(stranger, 'POST', '/entries/pages/about')).toBe(403)
    expect(await send(stranger, 'POST', '/entries/posts/theirs')).toBe(403)
    expect(await send(stranger, 'GET', '/entries/posts/theirs')).toBe(403)
    expect(await send(stranger, 'POST', '/entries/posts/theirs/publish')).toBe(403)
  })

  test('a person holding no listed role still edits every collection when every role is global', async () => {
    configureRoles({ editor: [], publisher: ['publish'] })

    const stranger = { id: 'u9', roles: ['stranger'] }

    expect(await send(stranger, 'POST', '/entries/pages/about')).toBe(200)
    expect(await send(stranger, 'POST', '/entries/pages/about/publish')).toBe(403)
  })
})

describe('a role limited to its own entries', () => {
  beforeEach(() => configureRoles({ blogger: { own: 'author', actions: [...ALL] }, boss: [...ALL] }))

  test('refuses every route on the entry of another, and does them on its own', async () => {
    for (const [method, name, path] of ENTRY_ROUTES) {
      expect(await send(me, method, path('posts', 'mine')), `${name} on its own`).toBe(200)
      expect(await send(me, method, path('posts', 'theirs')), `${name} on another's`).toBe(403)
    }
  })

  test('reads the entries of others, and lists them', async () => {
    expect(await send(me, 'GET', '/entries/posts/theirs')).toBe(200)
    expect(await send(me, 'GET', '/slugs/posts')).toBe(200)
  })

  test('changes no entry with no recorded writer, or an empty one, and a broader role does', async () => {
    for (const slug of ['orphan', 'blank']) {
      expect(await send(me, 'POST', `/entries/posts/${slug}`), slug).toBe(403)
      expect(await send(me, 'DELETE', `/entries/posts/${slug}`), slug).toBe(403)
      expect(await send(me, 'POST', `/entries/posts/${slug}/publish`), slug).toBe(403)
      expect(await send({ id: 'u3', roles: ['boss'] }, 'POST', `/entries/posts/${slug}`), slug).toBe(200)
    }
  })

  test('does not count a person the guard did not name as the writer of an entry with none', async () => {
    stored.set('posts/orphan', { title: 'Orphan', author: undefined })
    expect(await send({ id: '', roles: ['blogger'] }, 'POST', '/entries/posts/orphan')).toBe(403)
  })

  test('cannot reorder, which rewrites the neighbours', async () => {
    expect(await send(me, 'POST', '/entries/posts/mine/move?direction=down')).toBe(403)
    expect(await send({ id: 'u3', roles: ['boss'] }, 'POST', '/entries/posts/mine/move?direction=down')).toBe(200)
  })

  test('restores its own deleted entries and no others', async () => {
    expect(await send(me, 'POST', '/trash/posts/t-mine/restore')).toBe(200)
    expect(await send(me, 'POST', '/trash/posts/t-theirs/restore')).toBe(403)
    expect(await send(me, 'POST', '/trash/posts/gone/restore')).toBe(403)
  })

  test('uploads into any collection, as no entry is concerned', async () => {
    expect(await send(me, 'POST', '/files/pages')).toBe(200)
  })

  test('a new entry is written with the person, whatever the body names', async () => {
    const ctx = ask({ path: '/entries/posts/fresh', user: me, body: { data: { title: 'New', author: 'u2' }, create: true } })

    expect(await statusOf(ctx)).toBe(200)
    expect(stamps.get(ctx.request)).toEqual([{ field: 'author', value: 'u1' }])
  })

  test('a save keeps the writer of the entry it changes', async () => {
    const ctx = ask({ path: '/entries/posts/mine', user: me, body: { data: { title: 'Changed', author: 'u2' } } })

    expect(await statusOf(ctx)).toBe(200)
    expect(stamps.get(ctx.request)).toEqual([{ field: 'author', value: 'u1' }])
  })

  test('creating over the slug of another person\'s entry is refused', async () => {
    expect(await send(me, 'POST', '/entries/posts/theirs', { data: { title: 'Mine now' }, create: true })).toBe(403)
  })

  test('a query locale cannot make the entry look absent to the guard while the route saves the body\'s', async () => {
    expect(await send(me, 'POST', '/entries/posts/theirs?locale=zz', { data: { title: 'Mine now' }, create: true })).toBe(403)
    expect(await send(me, 'POST', '/entries/posts/theirs?locale=zz', { data: { title: 'Mine now' }, locale: 'en' })).toBe(403)
    expect(await send(me, 'POST', '/entries/posts/theirs?locale=en', { data: { title: 'Mine now' }, locale: 'zz' })).toBe(403)
    expect(await send(me, 'POST', '/entries/posts/theirs', { data: { title: 'Mine now' }, locale: 7 })).toBe(403)
    expect(await send(me, 'POST', '/entries/posts/theirs?locale=zz', { data: { title: 'Mine now' }, locale: 'zz' })).toBe(200)
  })

  test('the locale of a history restore or erasure is the body\'s, as the route reads it', async () => {
    expect(await send(me, 'POST', '/history/posts/theirs/restore?locale=zz', { at: 1 })).toBe(403)
    expect(await send(me, 'POST', '/history/posts/theirs/erase?locale=zz', { locale: 'en' })).toBe(403)
    expect(await send(me, 'POST', '/history/posts/mine/restore?locale=zz', { at: 1, locale: 'en' })).toBe(403)
    expect(await send(me, 'POST', '/history/posts/mine/restore', { at: 1, locale: 'en' })).toBe(200)
  })

  test('a save of an entry that cannot be read is no new entry', async () => {
    unreadable.add('posts')

    expect(await send(me, 'POST', '/entries/posts/fresh', { data: { title: 'New' }, create: true })).toBe(403)
    expect(await send(me, 'POST', '/entries/posts/theirs', { data: { title: 'Mine now' }, create: true })).toBe(403)
  })

  test('a restore keeps the writer the entry has now', async () => {
    const ctx = ask({ path: '/history/posts/mine/restore', user: me, body: { at: 1 } })

    expect(await statusOf(ctx)).toBe(200)
    expect(stamps.get(ctx.request)).toEqual([{ field: 'author', value: 'u1' }])
  })

  test('a broader role stamps nothing on an entry it changes, and the writer on one it makes', async () => {
    const boss = { id: 'u3', roles: ['boss'] }
    const changed = ask({ path: '/entries/posts/theirs', user: boss, body: { data: { title: 'x' } } })
    const made = ask({ path: '/entries/posts/fresh', user: { id: 'u1', roles: ['blogger', 'boss'] }, body: { data: { title: 'x' }, create: true } })
    const both = ask({ path: '/entries/posts/theirs', user: { id: 'u1', roles: ['blogger', 'boss'] }, body: { data: { title: 'x' } } })

    expect(await statusOf(changed)).toBe(200)
    expect(await statusOf(made)).toBe(200)
    expect(await statusOf(both)).toBe(200)
    expect(stamps.get(changed.request)).toBeUndefined()
    expect(stamps.get(made.request)).toEqual([{ field: 'author', value: 'u1' }])
    expect(stamps.get(both.request)).toBeUndefined()
  })

  test('a field naming several writers counts each', async () => {
    stored.set('posts/shared', { title: 'Shared', author: ['u2', 'u1'] })
    expect(await send(me, 'POST', '/entries/posts/shared')).toBe(200)
  })

  test('restores a version without the power to publish when it may not', async () => {
    configureRoles({ blogger: { own: 'author' } })

    const restore = ask({ path: '/history/posts/mine/restore', user: me, body: { at: 1 } })

    expect(await statusOf(restore)).toBe(200)
    expect(isRestrained(restore.request)).toBe(true)
  })

  test('still publishes only what its role lists', async () => {
    configureRoles({ blogger: { own: 'author', actions: ['publish'] } })
    expect(await send(me, 'POST', '/entries/posts/mine/publish')).toBe(200)
    expect(await send(me, 'DELETE', '/entries/posts/mine')).toBe(403)
  })
})

describe('a rename rewrites the entries that refer to it', () => {
  beforeEach(() => {
    configureRoles({ blogger: { collections: ['posts'], own: 'author', actions: [...ALL] }, boss: [...ALL] })
  })

  test('is refused to a role that cannot change one of them', async () => {
    referrers.set('posts/mine', [{ collection: 'pages', data: { author: 'u1' } }])
    expect(await send(me, 'POST', '/entries/posts/mine/rename', { slug: 'new' })).toBe(403)

    referrers.set('posts/mine', [{ collection: 'posts', data: { author: 'u2' } }])
    expect(await send(me, 'POST', '/entries/posts/mine/rename', { slug: 'new' })).toBe(403)
  })

  test('goes through when every one of them is the person\'s', async () => {
    referrers.set('posts/mine', [{ collection: 'posts', data: { author: 'u1' } }])
    expect(await send(me, 'POST', '/entries/posts/mine/rename', { slug: 'new' })).toBe(200)
    expect(await send(me, 'POST', '/entries/posts/mine/rename', { slug: 'new' })).toBe(200)
  })

  test('is not held up by them for a role with no limit', async () => {
    referrers.set('posts/mine', [{ collection: 'pages', data: { author: 'u2' } }])
    expect(await send({ id: 'u3', roles: ['boss'] }, 'POST', '/entries/posts/mine/rename', { slug: 'new' })).toBe(200)
  })
})

describe('bulk actions are one call per row', () => {
  test('a selection spanning both writers is refused row by row', async () => {
    configureRoles({ blogger: { own: 'author', actions: [...ALL] } })

    const rows = ['mine', 'theirs', 'orphan']
    const answers = []

    for (const slug of rows) {
      answers.push(await send(me, 'POST', `/entries/posts/${slug}/publish`))
      answers.push(await send(me, 'DELETE', `/entries/posts/${slug}`))
    }

    expect(answers).toEqual([200, 200, 403, 403, 403, 403])
  })
})

describe('the array form of an older config', () => {
  test('is the same role as before: every collection, every entry', async () => {
    configureRoles({ editor: [], publisher: ['publish'] })

    expect(await send({ id: 'u1', roles: ['editor'] }, 'POST', '/entries/pages/about')).toBe(200)
    expect(await send({ id: 'u1', roles: ['editor'] }, 'POST', '/entries/posts/theirs/publish')).toBe(403)
    expect(await send({ id: 'u1', roles: ['publisher'] }, 'POST', '/entries/posts/theirs/publish')).toBe(200)
    expect(await send({ id: 'u1', roles: ['publisher'] }, 'POST', '/redirects')).toBe(403)
  })

  test('mixes with a limited role in one config', async () => {
    configureRoles({ publisher: ['publish'], blogger: { collections: ['posts'] } })

    expect(await send({ id: 'u1', roles: ['publisher'] }, 'POST', '/entries/pages/about/publish')).toBe(200)
    expect(await send({ id: 'u1', roles: ['blogger'] }, 'POST', '/entries/pages/about')).toBe(403)
  })
})

describe('the config', () => {
  const check = (roles: Record<string, unknown>) => () => checkRoles(roles as never, true)

  test('reads the limits of a role', () => {
    const roles = checkRoles({ blogger: { collections: ['posts'], own: 'author', actions: ['publish'] }, editor: [] }, true)!

    expect(roles.get('blogger')).toEqual({ actions: new Set(['publish']), collections: new Set(['posts']), own: 'author' })
    expect(roles.get('editor')).toEqual({ actions: new Set(), collections: undefined, own: undefined })
  })

  test('refuses what it cannot read', () => {
    expect(check({ a: { colections: ['posts'] } })).toThrow('the key "colections"')
    expect(check({ a: { collections: [] } })).toThrow('list of collection names')
    expect(check({ a: { collections: 'posts' } })).toThrow('list of collection names')
    expect(check({ a: { own: '' } })).toThrow('own field')
    expect(check({ a: { own: 3 } })).toThrow('own field')
    expect(check({ a: { actions: ['fly'] } })).toThrow('the action "fly"')
    expect(check({ a: 'publish' })).toThrow('takes a list')
  })
})

const { default: screenGuard } = await import('../src/routes/_guard')

describe('the screens', () => {
  function screen(path: string, user: { id: string, roles: string[] }): GuardContext {
    const url = new URL(`http://site.test${path}`)

    return {
      request: new Request(url),
      url,
      cookies: new Bun.CookieMap(),
      locals: { auth: { bareUser: async () => user, isGranted: (role: string, who: { roles: string[] }) => who.roles.includes(role) } },
      deny: (status: number, message?: string) => {
        throw new Denied(status, message)
      },
    } as unknown as GuardContext
  }

  async function opens(path: string, user = me): Promise<boolean> {
    try {
      await screenGuard(screen(path, user))

      return true
    }
    catch (error) {
      if (error instanceof Denied)
        return false

      throw error
    }
  }

  test('refuse a collection out of reach on each of its screens, and open the others', async () => {
    configureRoles({ blogger: { collections: ['posts'] }, boss: [] })

    for (const path of ['/admin/collections/posts', '/admin/collections/posts/mine', '/admin/new/posts', '/admin/trash/posts', '/admin/history/posts/mine', '/admin', '/admin/translations'])
      expect(await opens(path), path).toBe(true)

    for (const path of ['/admin/collections/pages', '/admin/collections/pages/about', '/admin/new/pages', '/admin/trash/pages', '/admin/history/pages/about', '//admin//collections//pages/', '/admin/collections/pa%67es'])
      expect(await opens(path), path).toBe(false)

    expect(await opens('/admin/collections/pages', { id: 'u3', roles: ['boss'] })).toBe(true)
  })

  test('refuse a path the prefix is not in, which they cannot place', async () => {
    configureRoles({ blogger: { collections: ['posts'] } })
    expect(await opens('/elsewhere/collections/pages')).toBe(false)
  })

  test('refuse the media and unused-uploads screens to a role limited by collections or to its own entries', async () => {
    const sitewide = ['/admin/media', '/admin/uploads', '//admin//media/']

    configureRoles({ blogger: { collections: ['posts'] }, boss: [] })

    for (const path of sitewide) {
      expect(await opens(path), path).toBe(false)
      expect(await opens(path, { id: 'u3', roles: ['boss'] }), path).toBe(true)
    }

    configureRoles({ blogger: { own: 'author' }, boss: [] })

    for (const path of sitewide)
      expect(await opens(path), path).toBe(false)
  })

  test('leave the media and unused-uploads screens open when no role is limited, or the app lists none', async () => {
    configureRoles({ blogger: ['publish'] })
    expect(await opens('/admin/media')).toBe(true)
    expect(await opens('/admin/uploads')).toBe(true)

    configure({ guard: () => undefined, prefix: '/admin' })
    expect(await opens('/admin/media')).toBe(true)
  })

  test('open every collection to a role of the array form', async () => {
    configureRoles({ blogger: ['publish'] })
    expect(await opens('/admin/collections/pages')).toBe(true)
  })
})

describe('what the screens tell a person', () => {
  const as = (user: { id: string, roles: string[] }) => ({ locals: { auth: { bareUser: async () => user, isGranted: (role: string, who: { roles: string[] }) => who.roles.includes(role) } }, request: new Request('http://site.test/') }) as unknown as GuardContext

  test('says why a collection out of reach, or an entry of another, cannot be changed', async () => {
    configureRoles({ blogger: { collections: ['posts'], own: 'author', actions: [...ALL] }, boss: [...ALL] })

    const { denials, reachOf, ownerKey } = await import('../src/access')

    expect(await denials(as(me), { collection: 'posts', entry: { data: stored.get('posts/mine') } })).toEqual({ move: expect.stringContaining('moving one changes the others') })
    expect(await denials(as(me), { collection: 'posts', entry: { data: stored.get('posts/theirs') } })).toEqual(expect.objectContaining({ edit: 'Your role may only change the entries you wrote', publish: expect.any(String), delete: expect.any(String), redirects: expect.any(String), review: expect.any(String), upload: expect.any(String) }))
    expect(await denials(as(me), { collection: 'pages' })).toEqual(expect.objectContaining({ edit: 'Your role does not reach this collection', upload: expect.any(String) }))
    expect(await denials(as({ id: 'u3', roles: ['boss'] }), { collection: 'pages' })).toEqual({})

    const reaches = await reachOf(as(me))

    expect([reaches('posts'), reaches('pages')]).toEqual([true, false])
    expect(ownerKey({ id: undefined, name: 'Ann', held: [], email: 'a@b.c' })).toBe('a@b.c')
    expect(ownerKey({ name: 'Ann', held: [] })).toBe('Ann')
    expect(ownerKey(undefined)).toBe('')
  })

  test('says the site-wide screens are out of reach of a role limited to collections or to its own entries', async () => {
    const { denials } = await import('../src/access')

    configureRoles({ blogger: { collections: ['posts'] }, owner: { own: 'author' }, boss: [], plain: ['publish'] })

    expect((await denials(as(me))).site).toContain('does not reach')
    expect((await denials(as({ id: 'u2', roles: ['owner'] }))).site).toContain('does not reach')
    expect((await denials(as({ id: 'u3', roles: ['boss'] }))).site).toBeUndefined()
    // A collection's own screens say nothing of the site's.
    expect((await denials(as(me), { collection: 'posts' })).site).toBeUndefined()

    configure({ guard: () => undefined })
    expect((await denials(as(me))).site).toBeUndefined()
  })
})

describe('several roles limited to their own entries by different fields', () => {
  test('a new entry carries the person in each of the fields', async () => {
    configureRoles({ blogger: { own: 'author', actions: ['publish'] }, editor: { own: 'owner', actions: ['publish'] } })

    const ctx = ask({ path: '/entries/posts/fresh', user: { id: 'u1', roles: ['blogger', 'editor'] }, body: { data: { title: 'New', owner: 'u2' }, create: true } })

    expect(await statusOf(ctx)).toBe(200)
    expect(stamps.get(ctx.request)).toEqual([{ field: 'author', value: 'u1' }, { field: 'owner', value: 'u1' }])
  })
})

describe('cms({ can })', () => {
  const asked: Record<string, unknown>[] = []
  let answer: (question: Record<string, unknown>) => boolean | Promise<boolean>

  beforeEach(() => {
    asked.length = 0
    answer = () => true
    configure({ guard: async () => undefined, roles: { blogger: { own: 'author', actions: [...ALL] }, boss: [...ALL] }, can: async (question) => {
      asked.push(question as unknown as Record<string, unknown>)

      return answer(question as unknown as Record<string, unknown>)
    } })
  })

  test('is asked what the roles let through, with the person, the collection and the entry as stored', async () => {
    expect(await send(me, 'POST', '/entries/posts/mine')).toBe(200)
    expect(asked).toEqual([{ person: { id: 'u1', name: 'u1', email: undefined, roles: ['blogger'] }, action: 'edit', collection: 'posts', entry: { data: stored.get('posts/mine') } }])
  })

  test('is not asked what the roles refuse, and cannot widen them', async () => {
    expect(await send(me, 'POST', '/entries/posts/theirs')).toBe(403)
    expect(asked).toEqual([])
  })

  test('is asked of a new entry without one, and of a site-wide act without a collection', async () => {
    const boss = { id: 'u3', roles: ['boss'] }

    expect(await send(me, 'POST', '/entries/posts/fresh', { data: { title: 'New' }, create: true })).toBe(200)
    expect(await send(boss, 'POST', '/redirects')).toBe(200)
    expect(asked.map(({ action, collection, entry }) => [action, collection, entry])).toEqual([['edit', 'posts', undefined], ['redirects', undefined, undefined]])
  })

  test('refuses a request it answers no to, a read included, and a request it throws on', async () => {
    answer = ({ action }) => action !== 'edit'

    expect(await send(me, 'POST', '/entries/posts/mine')).toBe(403)
    expect(await send(me, 'GET', '/entries/posts/mine')).toBe(200)

    answer = ({ action }) => action !== 'read'

    expect(await send(me, 'GET', '/entries/posts/mine')).toBe(403)

    answer = () => {
      throw new Error('the service is down')
    }

    expect(await send(me, 'POST', '/entries/posts/mine')).toBe(403)
    expect(await send(me, 'GET', '/entries/posts/mine')).toBe(403)
  })

  test('is given with roles only', () => {
    expect(() => configure({ guard: () => undefined, can: () => true })).toThrow('roles')
  })
})
