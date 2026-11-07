import type * as Content from '../src/kay/content'
import type { CollectionInfo } from '../src/kay/contract'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { configure } from '../src/settings'

const products: CollectionInfo = { name: 'products', kind: 'loaded', schema: { type: 'object', properties: { name: { type: 'string' } } }, components: [], localized: false }

const content: Partial<typeof Content> = {
  ...await import('kay/content'),
  collections: async () => [products],
  collectionInfo: async () => products,
  entries: async () => [],
  saveEntry: async () => ({ ok: true }),
}

void mock.module('../src/kay/content', () => content)

const { saveEntry } = await import('../src/store')

const entry = { collection: 'products', slug: 'mug', data: { name: 'Mug' } }
// Where kay sends what it and its libraries log, as the app's `log` setting says.
const LOG_SINK = Symbol.for('kay.log')
const global = globalThis as { [LOG_SINK]?: unknown }
const sink = global[LOG_SINK]
let logged: unknown[][]

beforeEach(() => {
  logged = []
  global[LOG_SINK] = (...args: unknown[]) => logged.push(args)
})

afterEach(() => {
  global[LOG_SINK] = sink
})

test('reports a hook that throws with its source, and the save stands', async () => {
  const failure = new Error('hook down')

  configure({ onSave: () => {
    throw failure
  } })
  expect(await saveEntry(entry)).toHaveProperty('saved', true)
  expect(logged).toContainEqual(['error', 'cms.onSave failed', failure, undefined, 'kay'])
})

test('reports a hook that rejects, and the save stands', async () => {
  const failure = new Error('webhook refused')

  configure({ onSave: async () => Promise.reject(failure) })
  expect(await saveEntry(entry)).toHaveProperty('saved', true)
  expect(logged).toContainEqual(['error', 'cms.onSave failed', failure, undefined, 'kay'])
})
