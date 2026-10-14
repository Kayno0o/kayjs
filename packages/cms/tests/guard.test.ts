import type { GuardContext } from 'kay'
import { describe, expect, mock, test } from 'bun:test'
import * as server from 'kay/server'
import { authors } from '../src/authors'
import { configure } from '../src/settings'

class Refused extends Error {}

// An edit-mode request carries this header here, standing in for kay's signed cookie.
void mock.module('kay/server', () => ({ ...server, editRequested: (request: Request) => request.headers.has('x-edit') }))

const { default: apiGuard } = await import('../src/api/_guard')
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

    for (const [method, path] of [['POST', '/entries/posts/hello'], ['DELETE', '/entries/posts/hello'], ['POST', '/files/posts']] as const)
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
})
