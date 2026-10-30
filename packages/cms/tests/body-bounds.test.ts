import type { ActionOptions } from '../../../src/server/actions'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { Elysia } from 'elysia'
import { serveApi } from '../../../src/server/api'

const saved: number[] = []
const store = await import('../src/store')

// The real store but for the write, so the route's own body schema is what decides.
void mock.module('../src/store', () => ({
  ...store,
  saveEntry: async (place: { body?: string }) => {
    saved.push(place.body?.length ?? 0)

    return { ok: true }
  },
}))

const app = new Elysia()

await serveApi(app, [
  { file: join(import.meta.dir, '../src/api/entries.ts'), mount: '/api/cms/entries', guards: [], open: true },
  { file: join(import.meta.dir, '../src/api/markdown.ts'), mount: '/api/cms/markdown', guards: [], open: true },
], { i18n: { settings: { locales: ['en'], defaultLocale: 'en' }, translations: new Map() } } as unknown as ActionOptions)

const post = async (path: string, body: object) => app.handle(new Request(`http://site.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'origin': 'http://site.test' }, body: JSON.stringify(body) }))

test('an entry body between the api default and 5,000,000 characters is accepted, and one past it is refused', async () => {
  const text = 'a'.repeat(200_000)

  expect((await post('/api/cms/entries/posts/hello', { data: {}, body: text })).status).toBe(200)
  expect(saved).toEqual([text.length])
  expect((await post('/api/cms/entries/posts/hello', { data: {}, body: 'a'.repeat(5_000_001) })).status).toBe(422)
})

test('a markdown preview between the api default and its 1mb request limit is accepted', async () => {
  const response = await post('/api/cms/markdown', { markdown: 'word '.repeat(40_000) })

  expect(response.status).toBe(200)
  expect(await response.json()).toHaveProperty('html')
})
