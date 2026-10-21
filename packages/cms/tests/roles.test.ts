import type { GuardContext } from 'kay'
import { describe, expect, mock, test } from 'bun:test'
import * as server from 'kay/server'
import { passwordGuard, SESSION_COOKIE } from '../src/password'
import { configure } from '../src/settings'

class Denied {
  constructor(readonly status: number, readonly message?: string) {}
}

// An entry that exists as published, in a collection with a draft flag and a publish date.
const saved: Record<string, unknown> = { title: 'Hello', draft: false, publishAt: '2026-01-01' }

void mock.module('kay/server', () => ({ ...server, editRequested: () => false, editedEntry: () => false }))
void mock.module('../src/store', () => ({
  collectionNamed: async (name: string) => ({ name, draftField: 'draft', publishField: 'publishAt', unpublishField: undefined }),
  entryScreen: async ({ slug }: { slug: string }) => ({ entry: slug === 'hello' || slug === 'café' ? { data: saved } : undefined }),
}))

const { default: apiGuard } = await import('../src/api/_guard')

interface Asks { method?: string, path: string, body?: unknown, cookie?: string, user?: { roles: string[], email?: string } | null, headers?: Record<string, string> }

function ask({ method = 'POST', path, body, cookie, user, headers }: Asks): GuardContext {
  const url = new URL(`http://site.test/api/cms${path}`)
  const sent = { ...headers, ...body === undefined ? {} : { 'content-type': 'application/json' }, ...cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` } }

  return {
    request: new Request(url, { method, headers: sent, body: body === undefined ? null : JSON.stringify(body) }),
    url,
    cookies: new Bun.CookieMap(cookie === undefined ? '' : `${SESSION_COOKIE}=${cookie}`),
    locals: user === undefined
      ? {}
      : { auth: {
        bareUser: async () => user,
        isGranted: (role: string, who: { roles: string[] }) => who.roles.includes(role) || (role === 'editor' && who.roles.includes('admin')),
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

const roles = { editor: [], publisher: ['publish'], uploader: ['upload'], admin: ['publish', 'delete', 'upload', 'redirects'] } as const

function auth(): void {
  configure({ guard: async ({ locals }) => {
    if (await (locals as { auth: { bareUser: () => Promise<unknown> } }).auth.bareUser() === null)
      throw new Denied(401, 'Sign in')
  }, roles })
}

const RESTRICTED = [
  ['POST', '/entries/posts/hello/publish', 'publish'],
  ['POST', '/entries/posts/hello/unpublish', 'publish'],
  ['DELETE', '/entries/posts/hello', 'delete'],
  ['POST', '/files/unused/delete', 'delete'],
  ['POST', '/files/posts', 'upload'],
  ['POST', '/redirects', 'redirects'],
  ['POST', '/redirects/remove', 'redirects'],
  ['POST', '/redirects/dismiss', 'redirects'],
  ['POST', '/redirects/clear', 'redirects'],
  ['GET', '/redirects/paths?q=a', 'redirects'],
] as const

describe('roles', () => {
  test('without roles, everyone the guard admits may do it all', async () => {
    configure({ guard: () => undefined })

    for (const [method, path] of RESTRICTED)
      expect(await statusOf(ask({ method, path, user: { roles: [] } })), path).toBe(200)
  })

  test('with roles, an editor holding none of the listed actions may edit and nothing else, refused with a 403', async () => {
    auth()

    expect(await statusOf(ask({ path: '/entries/posts/hello', body: { data: saved }, user: { roles: ['editor'] } }))).toBe(200)
    expect(await statusOf(ask({ method: 'GET', path: '/entries/posts/hello', user: { roles: ['editor'] } }))).toBe(200)
    expect(await statusOf(ask({ path: '/entries/posts/hello/duplicate', user: { roles: ['editor'] } }))).toBe(200)

    for (const [method, path] of RESTRICTED)
      expect(await statusOf(ask({ method, path, user: { roles: ['editor'] } })), path).toBe(403)
  })

  test('a role allows exactly the actions it lists', async () => {
    auth()

    const publisher = { roles: ['publisher'] }

    expect(await statusOf(ask({ path: '/entries/posts/hello/publish', user: publisher }))).toBe(200)
    expect(await statusOf(ask({ path: '/entries/posts/hello/unpublish', user: publisher }))).toBe(200)
    expect(await statusOf(ask({ method: 'DELETE', path: '/entries/posts/hello', user: publisher }))).toBe(403)
    expect(await statusOf(ask({ path: '/files/posts', user: publisher }))).toBe(403)
    expect(await statusOf(ask({ path: '/files/posts', user: { roles: ['uploader'] } }))).toBe(200)
    expect(await statusOf(ask({ path: '/redirects', user: { roles: ['uploader'] } }))).toBe(403)

    for (const [method, path] of RESTRICTED)
      expect(await statusOf(ask({ method, path, user: { roles: ['admin'] } })), path).toBe(200)
  })

  test('the actions of a person\'s roles add up', async () => {
    auth()
    expect(await statusOf(ask({ path: '/files/posts', user: { roles: ['publisher', 'uploader'] } }))).toBe(200)
    expect(await statusOf(ask({ path: '/entries/posts/hello/publish', user: { roles: ['publisher', 'uploader'] } }))).toBe(200)
  })

  test('a role the request claims is no role: only the session\'s counts', async () => {
    auth()

    for (const headers of [{ 'x-role': 'admin' }, { 'x-roles': 'admin' }, { authorization: 'Bearer admin' }, { cookie: 'role=admin; roles=admin' }])
      expect(await statusOf(ask({ method: 'DELETE', path: '/entries/posts/hello', user: { roles: ['editor'] }, headers })), JSON.stringify(headers)).toBe(403)

    // A person whose roles the app does not list holds no action.
    expect(await statusOf(ask({ method: 'DELETE', path: '/entries/posts/hello', user: { roles: ['stranger'] } }))).toBe(403)
    // A role named like an object's own keys is a name here, and holds nothing unless listed.
    expect(await statusOf(ask({ method: 'DELETE', path: '/entries/posts/hello', user: { roles: ['__proto__', 'constructor', 'toString'] } }))).toBe(403)
  })

  test('a route spelled with a doubled or trailing slash is held to the same role', async () => {
    auth()

    for (const path of ['/entries/posts/hello/publish/', '//entries/posts/hello/publish', '/redirects/', '/files//posts'])
      expect(await statusOf(ask({ path, user: { roles: ['editor'] } })), path).toBe(403)
  })

  test('an anonymous request is a 401 the guard gave, before any role is read', async () => {
    auth()
    expect(await statusOf(ask({ method: 'DELETE', path: '/entries/posts/hello', user: null }))).toBe(401)
  })

  test('a password guard\'s roles are the roles the cookie was signed for', async () => {
    const passwords = { editor: 'pw-editor', admin: 'pw-admin' }
    const guard = passwordGuard(passwords)
    const { activePasswords } = await import('../src/password')

    configure({ guard, roles })

    const editor = activePasswords()!.issue('editor', false).value
    const admin = activePasswords()!.issue('admin', false).value

    expect(await statusOf(ask({ method: 'DELETE', path: '/entries/posts/hello', cookie: editor }))).toBe(403)
    expect(await statusOf(ask({ method: 'DELETE', path: '/entries/posts/hello', cookie: admin }))).toBe(200)
    expect(await statusOf(ask({ method: 'DELETE', path: '/entries/posts/hello' }))).toBe(401)

    // The editor's signature behind the admin's name.
    const [, expires, signature] = editor.split('.')

    expect(await statusOf(ask({ method: 'DELETE', path: '/entries/posts/hello', cookie: `admin.${expires}.${signature}` }))).toBe(401)
  })

  test('a save that is not a JSON object with a data object is refused to a role that may not publish, whatever its content type', async () => {
    auth()

    const form = new FormData()

    form.append('data', JSON.stringify({ title: 'Hello', draft: false }))

    for (const [body, type] of [[form, undefined], ['data={"draft":false}', 'text/plain'], ['not json', 'application/json'], ['{"data":"x"}', 'application/json'], ['null', 'application/json']] as const) {
      const ctx = ask({ path: '/entries/posts/hello', user: { roles: ['editor'] } })
      const url = new URL('http://site.test/api/cms/entries/posts/hello')

      Object.assign(ctx, { request: new Request(url, { method: 'POST', body, ...type === undefined ? {} : { headers: { 'content-type': type } } }) })
      expect(await statusOf(ctx), String(type)).toBe(403)
    }
  })

  test('a save of an entry whose slug is percent-encoded finds the entry it edits', async () => {
    auth()
    expect(await statusOf(ask({ path: '/entries/posts/caf%C3%A9', body: { data: { ...saved, title: 'Changed' } }, user: { roles: ['editor'] } }))).toBe(200)
    expect(await statusOf(ask({ path: '/entries/posts/caf%C3%A9', body: { data: { ...saved, draft: true } }, user: { roles: ['editor'] } }))).toBe(403)
  })

  test('a save is held to the publishing rights too: it may not flip the draft flag or the publish date', async () => {
    auth()

    const editor = { roles: ['editor'] }
    const save = async (path: string, data: Record<string, unknown>, user = editor) => statusOf(ask({ path, body: { data, create: false }, user }))

    expect(await save('/entries/posts/hello', { ...saved, title: 'Changed' })).toBe(200)
    expect(await save('/entries/posts/hello', { ...saved, draft: true })).toBe(403)
    expect(await save('/entries/posts/hello', { ...saved, publishAt: '2020-01-01' })).toBe(403)
    expect(await save('/entries/posts/hello', { title: 'Hello' })).toBe(403)
    // A new entry starts as a draft with nothing scheduled.
    expect(await save('/entries/posts/new', { title: 'New', draft: true })).toBe(200)
    expect(await save('/entries/posts/new', { title: 'New', draft: false })).toBe(403)
    expect(await save('/entries/posts/new', { title: 'New' })).toBe(403)
    expect(await save('/entries/posts/new', { title: 'New', draft: true, publishAt: '2020-01-01' })).toBe(403)
    // Whom may publish saves freely.
    expect(await save('/entries/posts/hello', { ...saved, draft: true }, { roles: ['publisher'] })).toBe(200)
    expect(await save('/entries/posts/new', { title: 'New', draft: false }, { roles: ['admin'] })).toBe(200)
  })
})

describe('cms({ roles })', () => {
  test('needs a guard, and only the known actions', () => {
    expect(() => configure({ roles })).toThrow('needs a `guard`')
    expect(() => configure({ guard: () => undefined, roles: { editor: ['everything'] as never } })).toThrow('everything')
    expect(() => configure({ guard: () => undefined, roles: { editor: 'publish' as never } })).toThrow('list of')
  })
})

class Redirected {
  constructor(readonly location: string) {}
}

describe('the screens for a site on kayjs-auth', () => {
  async function visit(path: string, method = 'GET', signInUrl: ((back?: string) => string) | undefined = back => `/login?redirect=${encodeURIComponent(back ?? '/')}`): Promise<string | number> {
    const { default: screenGuard } = await import('../src/routes/_guard')
    const url = new URL(`http://site.test${path}`)
    const ctx = {
      request: new Request(url, { method }),
      url,
      cookies: new Bun.CookieMap(),
      locals: { auth: { bareUser: async () => null, signInUrl } },
      redirect: (location: string) => {
        throw new Redirected(location)
      },
      deny: (status: number) => {
        throw new Denied(status)
      },
    } as unknown as GuardContext

    try {
      await screenGuard(ctx)

      return 200
    }
    catch (error) {
      return error instanceof Redirected ? error.location : (error as Denied).status
    }
  }

  test('sends an anonymous visitor the app\'s guard turned away with a 401 to its sign-in page, back to this exact page', async () => {
    configure({ guard: ({ deny }) => deny(401, 'Sign in') })

    expect(await visit('/admin/collections/posts?q=a&sort=title')).toBe('/login?redirect=%2Fadmin%2Fcollections%2Fposts%3Fq%3Da%26sort%3Dtitle')
  })

  test('leaves a post, a 403 and an app with no sign-in page as the guard answered', async () => {
    configure({ guard: ({ deny }) => deny(401, 'Sign in') })
    expect(await visit('/admin', 'POST')).toBe(401)
    expect(await visit('/admin', 'GET', () => {
      throw new Error('no sign-in page')
    })).toBe(401)

    configure({ guard: ({ deny }) => deny(403, 'No') })
    expect(await visit('/admin')).toBe(403)
  })

  test('a path that would leave the site leads home, not away', async () => {
    configure({ guard: ({ deny }) => deny(401, 'Sign in') })

    expect(await visit('//evil.example/x', 'GET', back => `/login?redirect=${encodeURIComponent(back ?? '/')}`)).toBe('/login?redirect=%2F')
  })
})
