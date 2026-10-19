import type { GuardContext } from 'kay'
import { describe, expect, mock, test } from 'bun:test'
import * as server from 'kay/server'
import { authors } from '../src/authors'
import { configure, settings } from '../src/settings'

class Refused extends Error {}

// An edit-mode request carries this header here, standing in for kay's signed cookie.
void mock.module('kay/server', () => ({ ...server, editRequested: (request: Request) => request.headers.has('x-edit') }))

const { default: apiGuard } = await import('../src/api/_guard')
const { default: screenGuard } = await import('../src/routes/_guard')
const ada = { name: 'Ada', email: 'ada@example.com' }

function context(method: string, path: string, edit: boolean): GuardContext {
  const url = new URL(`http://site.test/api/cms${path}`)

  return {
    request: new Request(url, { method, headers: edit ? { 'x-edit': '1' } : {} }),
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

describe('the API guard', () => {
  test('without a guard of the app\'s, lets edit mode alone read and write', async () => {
    configure({})

    expect(await admitted(context('POST', '/entries/posts/hello', true))).toBe(true)
    expect(await admitted(context('GET', '/entries/posts/hello', false))).toBe(false)
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

    return { request: new Request(url, { headers }), url, deny: (_code?: number, message?: string) => {
      throw new Refused(message)
    } } as unknown as GuardContext
  }

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
