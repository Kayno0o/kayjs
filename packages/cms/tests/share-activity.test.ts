import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { Elysia } from 'elysia'
import { s } from 'kay'
import { collection } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { activityOf } from '../src/activity'
import { sqliteLoader } from '../src/loaders/sqlite'
import { configure } from '../src/settings'

const store = await import('../src/store')

let shared = true

// A link is made by kay's `previewUrl`, which needs an app's preview settings: what is tested here is that the route logs it.
void mock.module('../src/store', () => ({
  ...store,
  shareLink: async () => shared ? { ok: true, link: '/post?share=x' } : { ok: false, issues: [], error: { status: 422, message: 'no page', errors: {}, data: undefined } },
}))

const { default: entriesApi } = await import('../src/api/entries')

let restore: ReturnType<typeof registerCollections>

beforeEach(() => {
  configure({})
  shared = true
  restore = registerCollections([['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table: 'share_notes' }), { schema: s.Object({ title: s.String() }) })]])
})

afterEach(() => {
  registerCollections(restore)
})

async function share(): Promise<void> {
  await new Elysia({ prefix: '/_kay/cms/entries' }).use(entriesApi).handle(new Request('http://site.test/_kay/cms/entries/notes/first/share', { method: 'POST' }))
}

test('logs a share link in the activity of its collection, and a refused one not', async () => {
  shared = false
  await share()
  expect(await activityOf('notes')).toEqual([])

  shared = true
  await share()
  expect((await activityOf('notes')).map(event => [event.verb, event.slug])).toEqual([['share', 'first']])
})
