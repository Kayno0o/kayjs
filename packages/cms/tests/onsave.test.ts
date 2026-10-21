import type * as Content from '../src/kay/content'
import type { CollectionInfo } from '../src/kay/contract'
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { log } from '../src/log'
import { configure } from '../src/settings'

const products: CollectionInfo = { name: 'products', kind: 'loaded', schema: { type: 'object', properties: { name: { type: 'string' } } }, components: [], localized: false }

const content: Partial<typeof Content> = {
  ...await import('kay/content'),
  collections: async () => [products],
  collectionInfo: async () => products,
  entries: async () => [],
  saveEntry: async () => ({}),
}

void mock.module('../src/kay/content', () => content)

const { saveEntry, setSaveHookLimit } = await import('../src/store')

const entry = { collection: 'products', slug: 'mug', data: { name: 'Mug' } }
let logged: ReturnType<typeof spyOn<typeof log, 'error'>>

beforeEach(() => {
  logged = spyOn(log, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  setSaveHookLimit()
  logged.mockRestore()
})

test('logs a hook that throws, and the save stands', async () => {
  const failure = new Error('hook down')

  configure({ onSave: () => {
    throw failure
  } })
  expect(await saveEntry(entry)).toHaveProperty('saved', true)
  expect(logged).toHaveBeenCalledWith('onSave failed for products/mug', failure)
})

test('logs a hook that rejects', async () => {
  const failure = new Error('webhook refused')

  configure({ onSave: async () => Promise.reject(failure) })
  expect(await saveEntry(entry)).toHaveProperty('saved', true)
  expect(logged).toHaveBeenCalledWith('onSave failed for products/mug', failure)
})

test('stops waiting for a hook past its time limit, and logs it', async () => {
  setSaveHookLimit(30)
  configure({ onSave: async () => new Promise(() => undefined) })

  const started = Date.now()

  expect(await saveEntry(entry)).toHaveProperty('saved', true)
  expect(Date.now() - started).toBeLessThan(2000)
  expect(logged).toHaveBeenCalledWith('onSave for products/mug did not finish in 0.03 s; the save does not wait for it')
})

test('logs a hook that fails after the limit, too', async () => {
  setSaveHookLimit(10)

  const failure = new Error('late failure')

  configure({ onSave: async () => {
    await Bun.sleep(60)

    throw failure
  } })
  await saveEntry(entry)
  await Bun.sleep(100)
  expect(logged).toHaveBeenCalledWith('onSave failed for products/mug', failure)
})
