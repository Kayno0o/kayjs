import { expect, mock, test } from 'bun:test'
import * as content from '../src/kay/content'
import { configure } from '../src/settings'
import * as store from '../src/store'

const collection = { name: 'posts', kind: 'loaded', schema: { type: 'object', properties: { title: { type: 'string' } } }, count: 3 }
const written = [
  { slug: 'mine', data: { title: 'Mine', author: 'u1' }, draft: false },
  { slug: 'theirs', data: { title: 'Theirs', author: 'u2' }, draft: false },
  { slug: 'orphan', data: { title: 'Orphan' }, draft: false },
]

void mock.module('../src/store', () => ({
  ...store,
  findCollection: async (name: string) => name === 'posts' ? collection : undefined,
  versionOf: async () => undefined,
  entryScreen: async () => undefined,
}))
void mock.module('../src/kay/content', () => ({
  ...content,
  entries: async () => written,
  translations: async () => new Map(),
  collections: async () => [collection, { ...collection, name: 'pages' }],
}))

const { listScreen, indexRows } = await import('../src/screens')

const member = (held: string[], id = 'u1') => ({ id, name: 'Ann', held })

test('the list locks the rows a role limited to its own entries may not change', async () => {
  configure({ guard: () => undefined, roles: { blogger: { own: 'author' }, boss: [] } })

  const listed = await listScreen({ collection: 'posts' }, member(['blogger']))

  expect(listed?.rows.map(row => [row.slug, row.locked])).toEqual([['mine', undefined], ['theirs', true], ['orphan', true]])
  expect((await listScreen({ collection: 'posts' }, member(['boss'])))?.rows.some(row => row.locked)).toBe(false)
  // Without a signed-in person, as an app's own page reads it, nothing is locked.
  expect((await listScreen({ collection: 'posts' }))?.rows.some(row => row.locked)).toBe(false)
})

test('the list locks every row of a collection a role does not reach, and the content list leaves it out', async () => {
  configure({ guard: () => undefined, roles: { blogger: { collections: ['pages'] } } })

  expect((await listScreen({ collection: 'posts' }, member(['blogger'])))?.rows.every(row => row.locked)).toBe(true)

  const reaching = (name: string) => name === 'pages'

  expect((await indexRows(reaching)).map(row => row.collection.name)).toEqual(['pages'])
})
