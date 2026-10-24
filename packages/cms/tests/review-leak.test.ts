import type { GuardContext } from 'kay'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Elysia } from 'elysia'
import { s } from 'kay'
import { collection } from 'kay/content'
import * as server from 'kay/server'
import { scratchDir } from 'kay/test'
import { registerCollections, registerEditSite } from '../../../src/content/edit'
import { contentPlace, setContentPlace } from '../../../src/content/load'
import { submitEntry } from '../src/reviewing'
import { configure } from '../src/settings'
import { saveEntry } from '../src/store'

class Refused {
  status = 403

  constructor(readonly message?: string) {}
}

// As in guard.test.ts, an edit-mode request carries this header in place of kay's signed cookie, and lists the entries its pages rendered.
void mock.module('kay/server', () => ({
  ...server,
  editRequested: (request: Request) => request.headers.has('x-edit'),
  editedEntry: (request: Request, collection: string, slug: string) => (request.headers.get('x-edit') ?? '').split(',').includes(`${collection}/${slug}`),
}))

const { default: entriesApi } = await import('../src/api/entries')
const { default: devApi } = await import('../src/api/dev')

Object.assign(devApi, { [Symbol.for('kay.api')]: '/_kay/cms/dev' })

const { default: apiGuard } = await import('../src/api/_guard')

const schema = s.Object({ title: s.String(), draft: s.Optional(s.Boolean()) })
const original = contentPlace()
let restore: ReturnType<typeof registerCollections>

beforeEach(async () => {
  const dir = await scratchDir('review-leak-')

  await mkdir(join(dir, 'posts'), { recursive: true })
  await mkdir(join(dir, '.git'), { recursive: true })
  setContentPlace(dir, dir)
  registerEditSite({ urls: async () => undefined, locales: ['en'], defaultLocale: 'en' })
  restore = registerCollections([['posts', collection(join(dir, 'posts'), { schema, draft: 'draft' })]])
  configure({ guard: ({ request, deny }) => request.headers.has('x-editor') ? undefined : deny(403, 'Editors only') })
  expect(await saveEntry({ collection: 'posts', slug: 'first', data: { title: 'One', draft: true } }, { create: true })).toMatchObject({ saved: true })
  expect(await submitEntry({ collection: 'posts', slug: 'first' }, { name: 'Wanda', id: 'writer-1', reviewers: [] })).toMatchObject({ saved: true })
})

afterEach(() => {
  registerCollections(restore)
  setContentPlace(original.root, original.base)
})

// Runs the API guard on the request, then the entries route on the same one: the answer, or the guard's refusal.
async function read(headers: Record<string, string>): Promise<{ review?: unknown } | undefined> {
  const url = new URL('http://site.test/_kay/cms/entries/posts/first')
  const request = new Request(url, { headers })
  const ctx = { request, url, deny: (_code?: number, message?: string) => {
    throw new Refused(message)
  } } as unknown as GuardContext

  try {
    await apiGuard(ctx)
  }
  catch (error) {
    if (error instanceof Refused)
      return undefined

    throw error
  }

  const response = await new Elysia({ prefix: '/_kay/cms/entries' }).use(entriesApi).handle(request)

  return response.json() as Promise<{ review?: unknown }>
}

describe('the entry read', () => {
  test('carries the review log for a signed-in editor, with no id of its writer', async () => {
    const answer = await read({ 'x-editor': '1' })

    expect(answer?.review).toMatchObject({ status: 'review', by: 'Wanda', events: [{ verb: 'submit' }] })
    expect(JSON.stringify(answer)).not.toContain('writer-1')
  })

  test('leaves it out for an edit link\'s holder, whom the guard turns away and the edit cookie lets read', async () => {
    const answer = await read({ 'x-edit': 'posts/first' })

    expect(answer).toMatchObject({ entry: { slug: 'first' } })
    expect(answer).not.toHaveProperty('review')
    expect(JSON.stringify(answer)).not.toContain('Wanda')
  })
})
