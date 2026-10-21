import type { GuardContext } from 'kay'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as server from 'kay/server'
import { authors } from '../src/authors'
import { configure, settings } from '../src/settings'

class Refused extends Error {}

// An edit-mode request carries this header here, standing in for kay's signed cookie, and lists the entries its pages rendered as collection/slug, comma-separated.
void mock.module('kay/server', () => ({
  ...server,
  editRequested: (request: Request) => request.headers.has('x-edit'),
  editedEntry: (request: Request, collection: string, slug: string) => (request.headers.get('x-edit') ?? '').split(',').includes(`${collection}/${slug}`),
}))

const { default: apiGuard } = await import('../src/api/_guard')
const { default: screenGuard } = await import('../src/routes/_guard')
const ada = { name: 'Ada', email: 'ada@example.com' }

function context(method: string, path: string, edit: boolean | string): GuardContext {
  const url = new URL(`http://site.test/api/cms${path}`)

  return {
    request: new Request(url, { method, headers: edit === false ? {} : { 'x-edit': edit === true ? 'posts/hello' : edit } }),
    url,
    deny: (_code?: number, message?: string) => {
      throw new Refused(message)
    },
  } as unknown as GuardContext
}

async function admitted(ctx: GuardContext): Promise<boolean> {
  try {
    await apiGuard(ctx)

    return true
  }
  catch (error) {
    if (error instanceof Refused)
      return false

    throw error
  }
}

const devCode = process.env.KAY_DEV_CODE

describe('the API guard', () => {
  beforeEach(() => {
    process.env.KAY_DEV_CODE = '0'
  })

  afterEach(() => {
    if (devCode === undefined)
      delete process.env.KAY_DEV_CODE
    else
      process.env.KAY_DEV_CODE = devCode
  })

  test('without a guard of the app\'s, lets edit mode alone read the entries of its pages and, under kay dev, write', async () => {
    configure({})

    expect(await admitted(context('POST', '/entries/posts/hello', true))).toBe(true)
    expect(await admitted(context('POST', '/files/posts', true))).toBe(true)
    expect(await admitted(context('GET', '/entries/posts/hello', true))).toBe(true)
    expect(await admitted(context('GET', '/entries/posts/hello', false))).toBe(false)
  })

  test('without one, a server outside kay dev (production, or NODE_ENV unset or staging) lets an edit link or cookie read its pages\' entries and leave, and write nothing', async () => {
    configure({})
    delete process.env.KAY_DEV_CODE

    expect(await admitted(context('GET', '/entries/posts/hello', true))).toBe(true)
    expect(await admitted(context('GET', '/files/rules', true))).toBe(true)
    expect(await admitted(context('GET', '/icons', true))).toBe(true)
    expect(await admitted(context('GET', '/icons', false))).toBe(false)
    expect(await admitted(context('POST', '/preview/exit', true))).toBe(true)

    for (const [method, path] of [['POST', '/entries/posts/hello'], ['POST', '/entries/posts/hello/publish'], ['POST', '/entries/posts/hello/unpublish'], ['POST', '/entries/posts/hello/move'], ['DELETE', '/entries/posts/hello'], ['PUT', '/entries/posts/hello'], ['POST', '/files/posts'], ['POST', '/files/unused/delete'], ['POST', '/files/media/rename'], ['POST', '/entries/posts/hello/rename'], ['POST', '/redirects'], ['POST', '/entries/preview/exit']] as const)
      expect(await admitted(context(method, path, true))).toBe(false)
  })

  test('reads no entry the pages shown in edit mode did not read, with a guard or without one', async () => {
    for (const guarded of [false, true]) {
      configure(guarded ? { guard: ({ deny }) => deny(403, 'Editors only') } : {})

      expect(await admitted(context('GET', '/entries/orders/42', 'posts/hello'))).toBe(false)
      expect(await admitted(context('GET', '/entries/posts/other', 'posts/hello'))).toBe(false)
      expect(await admitted(context('HEAD', '/entries/orders/42', 'posts/hello'))).toBe(false)
      expect(await admitted(context('GET', '/entries/orders/42', ''))).toBe(false)
      // The slugs of a collection are no entry the pages read.
      expect(await admitted(context('GET', '/slugs/posts', 'posts/hello'))).toBe(false)
      expect(await admitted(context('GET', '/entries/posts%2Forders/42', 'posts/hello'))).toBe(false)
      expect(await admitted(context('GET', '/entries/%E0%A4%A/42', 'posts/hello'))).toBe(false)
      expect(await admitted(context('GET', '/entries/posts/a/b', 'posts/hello'))).toBe(false)
      expect(await admitted(context('GET', '/entries/posts/hello/', 'posts/hello'))).toBe(false)
      expect(await admitted(context('GET', '/entries/orders/42', 'posts/hello,orders/42'))).toBe(true)
    }
  })

  test('lets a signed-in editor read any collection through the app\'s guard', async () => {
    configure({ guard: () => undefined })

    expect(await admitted(context('GET', '/entries/orders/42', 'posts/hello'))).toBe(true)
  })

  test('with one, lets edit mode read and leave, and only whom it admits write', async () => {
    configure({ guard: ({ request, deny }) => request.headers.has('x-editor') ? undefined : deny(403, 'Editors only') })

    expect(await admitted(context('GET', '/entries/posts/hello', true))).toBe(true)
    expect(await admitted(context('POST', '/preview/exit', true))).toBe(true)
    expect(await admitted(context('HEAD', '/entries/posts/hello', true))).toBe(true)

    for (const [method, path] of [['POST', '/entries/posts/hello'], ['PUT', '/entries/posts/hello'], ['PATCH', '/entries/posts/hello'], ['DELETE', '/entries/posts/hello'], ['POST', '/files/posts'], ['POST', '/redirects'], ['POST', '/redirects/remove'], ['POST', '/entries/preview/exit'], ['DELETE', '/preview/exit']] as const)
      expect(await admitted(context(method, path, true))).toBe(false)

    const signedIn = context('POST', '/entries/posts/hello', true)

    signedIn.request.headers.set('x-editor', '1')
    expect(await admitted(signedIn)).toBe(true)
  })

  test('keeps who the app says the editor is, for the save to commit as', async () => {
    configure({ guard: () => undefined, author: () => ada })

    const ctx = context('POST', '/entries/posts/hello', false)

    expect(await admitted(ctx)).toBe(true)
    expect(authors.get(ctx.request)).toEqual(ada)
  })

  test('names no author unless the app gives one, so the forge commits as its own account', async () => {
    configure({ guard: () => undefined })

    const ctx = context('POST', '/entries/posts/hello', false)

    expect(await admitted(ctx)).toBe(true)
    expect(authors.get(ctx.request)).toBeUndefined()
  })
})

describe('a guard loaded lazily', () => {
  test('loads nothing as cms() is set up, once on the first request, and keeps what it loaded', async () => {
    let loads = 0

    configure({ guard: { load: async () => {
      loads++

      return ({ request, deny }) => request.headers.has('x-editor') ? undefined : deny(403, 'Editors only')
    } } })
    expect(loads).toBe(0)
    expect(settings().guard).toBeTypeOf('function')

    expect(await admitted(context('POST', '/entries/posts/hello', false))).toBe(false)

    const signedIn = context('POST', '/entries/posts/hello', false)

    signedIn.request.headers.set('x-editor', '1')
    expect(await admitted(signedIn)).toBe(true)
    expect(loads).toBe(1)
  })

  test('tries to load again after a load that failed, and not after a guard that refused', async () => {
    let loads = 0

    configure({ guard: { load: () => {
      loads++

      if (loads === 1)
        throw new Error('database down')

      return () => undefined
    } } })

    await expect(apiGuard(context('POST', '/entries/posts/hello', false))).rejects.toThrow('database down')
    expect(await admitted(context('POST', '/entries/posts/hello', false))).toBe(true)
    expect(await admitted(context('POST', '/entries/posts/hello', false))).toBe(true)
    expect(loads).toBe(2)
  })
})

describe('the screens\' guard', () => {
  const screen = (path: string, headers: Record<string, string> = {}): GuardContext => {
    const url = new URL(`http://site.test${path}`)

    return { request: new Request(url, { headers }), url, cookies: new Bun.CookieMap(), deny: (_code?: number, message?: string) => {
      throw new Refused(message)
    } } as unknown as GuardContext
  }

  test('marks the editor it lets in with the hint the pages look for, and no other', async () => {
    configure({ guard: ({ request, deny }) => request.headers.has('x-editor') ? undefined : deny(403, 'Editors only') })

    const refused = screen('/admin')
    const admitted = screen('/admin', { 'x-editor': '1' })

    await expect(screenGuard(refused)).rejects.toThrow('Editors only')
    expect(refused.cookies.has('kay_editor')).toBe(false)
    await screenGuard(admitted)
    expect(admitted.cookies.get('kay_editor')).toBe('1')
    expect(admitted.cookies.toSetCookieHeaders()[0]).toMatch(/^kay_editor=1; .*Path=\/.*SameSite=Lax/)
  })

  test('sets the hint Secure behind a TLS-terminating proxy, and leaves it out with pageLink: false', async () => {
    configure({ guard: () => undefined })

    const proxied = screen('/admin', { 'x-forwarded-proto': 'https' })
    const plain = screen('/admin')

    await screenGuard(proxied)
    await screenGuard(plain)
    expect(proxied.cookies.toSetCookieHeaders()[0]).toContain('Secure')
    expect(plain.cookies.toSetCookieHeaders()[0]).not.toContain('Secure')
    configure({ guard: () => undefined, pageLink: false })

    const left = screen('/admin')

    await screenGuard(left)
    expect(left.cookies.has('kay_editor')).toBe(false)
  })

  test('keeps every screen closed, the missing pages included, while the app gives no guard', async () => {
    configure({})

    for (const path of ['/admin', '/admin/not-found', '/admin/uploads', '/admin/collections/posts'])
      await expect(screenGuard(screen(path))).rejects.toThrow('no guard')
  })

  test('lets in whom the app\'s guard admits', async () => {
    configure({ guard: ({ request, deny }) => request.headers.has('x-editor') ? undefined : deny(403, 'Editors only') })

    await expect(screenGuard(screen('/admin/not-found'))).rejects.toThrow('Editors only')
    await expect(Promise.resolve(screenGuard(screen('/admin/not-found', { 'x-editor': '1' })))).resolves.toBeUndefined()
  })
})
