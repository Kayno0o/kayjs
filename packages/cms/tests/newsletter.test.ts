import type { CacheStore, StoredValue } from '../../../src/runtime/cache'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { setupStore } from '../../../src/server/app-store'
import { testAddresses } from '../src/authors'
import { configure } from '../src/settings'

let draft = false
let version = 'v1'

void mock.module('../src/store', () => ({
  entryOf: async ({ slug }: { slug: string }) => slug === 'hello' ? { slug, data: { title: 'Hello' }, draft, version } : undefined,
}))

const { default: newsletterApi } = await import('../src/api/newsletter')

const calls: string[] = []
let failing = false
let runs = 0

const list = {
  send: async (message: { subject: string }) => {
    await Bun.sleep(10)

    if (failing)
      throw new Error('smtp down')

    calls.push(`send ${message.subject}`)

    return { id: 'b1', recipients: 3 }
  },
  test: async (message: { subject: string }, to: string) => {
    calls.push(`test ${message.subject} ${to}`)
  },
  preview: async (message: { subject: string }) => ({ subject: message.subject, html: '<p>Hi</p>', text: 'Hi' }),
  count: async () => 3,
}

async function post(path: string, to?: string) {
  const request = new Request(`http://site.test${path}`, { method: 'POST' })

  if (to !== undefined)
    testAddresses.set(request, to)

  const response = await newsletterApi.handle(request)

  return { status: response.status, body: await response.text() }
}

beforeEach(() => {
  calls.length = 0
  draft = false
  failing = false
  version = `v${++runs}`
  configure({ newsletter: { posts: { list, message: entry => ({ subject: String(entry.data?.title) }) } } })
})

afterEach(() => setupStore(undefined))

function memoryCache(): CacheStore & { rows: Map<string, StoredValue> } {
  const rows = new Map<string, StoredValue>()

  return { rows, get: key => rows.get(key), set: (key, text, freshUntil) => void rows.set(key, { text, freshUntil }), delete: key => void rows.delete(key), keys: () => [...rows.keys()] }
}

describe('the ledger of sends in the app\'s store', () => {
  test('remembers a send in store.cache, and refuses a version a restart or another process already sent', async () => {
    const cache = memoryCache()

    setupStore({ cache })
    expect((await post('/posts/hello/send')).status).toBe(200)
    expect([...cache.rows.keys()]).toEqual(['kayjs-cms:newsletter:posts/hello/'])

    // The same version, sent by another process: this one's own memory knows nothing of it.
    version = 'v-other'
    cache.rows.set('kayjs-cms:newsletter:posts/hello/', { text: 'v-other', freshUntil: Date.now() + 1000 })
    calls.length = 0

    expect((await post('/posts/hello/send')).status).toBe(409)
    expect(calls).toEqual([])
  })

  test('lets a changed version and an expired entry send, and does not keep a failed send', async () => {
    const cache = memoryCache()

    setupStore({ cache })
    cache.rows.set('kayjs-cms:newsletter:posts/hello/', { text: 'older', freshUntil: Date.now() + 1000 })
    expect((await post('/posts/hello/send')).status).toBe(200)

    version = 'v-next'
    cache.rows.set('kayjs-cms:newsletter:posts/hello/', { text: 'v-next', freshUntil: Date.now() - 1 })
    failing = true
    expect((await post('/posts/hello/send')).status).toBe(500)
    expect(cache.rows.get('kayjs-cms:newsletter:posts/hello/')?.text).toBe('v-next')

    failing = false
    expect((await post('/posts/hello/send')).status).toBe(200)
  })

  test('still sends when the store cannot write, and refuses when it cannot read', async () => {
    const cache = memoryCache()

    setupStore({ cache: { ...cache, set: () => {
      throw new Error('read only')
    } } })
    expect((await post('/posts/hello/send')).status).toBe(200)

    version = 'v-after'
    setupStore({ cache: { ...cache, get: () => {
      throw new Error('down')
    } } })
    expect((await post('/posts/hello/send')).status).toBe(500)
    expect(calls).toEqual(['send Hello'])
  })
})

describe('sending an entry to a list', () => {
  test('previews the mail with the subscriber count', async () => {
    const { status, body } = await post('/posts/hello/preview')

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ subject: 'Hello', html: '<p>Hi</p>', text: 'Hi', subscribers: 3 })
    expect(calls).toEqual([])
  })

  test('sends a test to the editor alone', async () => {
    const { status } = await post('/posts/hello/test', 'ed@example.com')

    expect(status).toBe(200)
    expect(calls).toEqual(['test Hello ed@example.com'])
  })

  test('refuses a test when no address was found for the editor', async () => {
    const { status, body } = await post('/posts/hello/test')

    expect(status).toBe(400)
    expect(body).toContain('testTo')
    expect(calls).toEqual([])
  })

  test('sends to the list once per version of the entry', async () => {
    expect((await post('/posts/hello/send')).status).toBe(200)
    expect(calls).toEqual(['send Hello'])
    expect((await post('/posts/hello/send')).status).toBe(409)
    expect(calls).toEqual(['send Hello'])

    version = 'v2'
    expect((await post('/posts/hello/send')).status).toBe(200)
    expect(calls).toEqual(['send Hello', 'send Hello'])
  })

  test('mails the list once when two requests arrive together', async () => {
    const statuses = (await Promise.all([post('/posts/hello/send'), post('/posts/hello/send')])).map(response => response.status).sort()

    expect(statuses).toEqual([200, 409])
    expect(calls).toEqual(['send Hello'])
  })

  test('lets a send that failed be tried again', async () => {
    failing = true
    expect((await post('/posts/hello/send')).status).toBe(500)

    failing = false
    expect((await post('/posts/hello/send')).status).toBe(200)
    expect(calls).toEqual(['send Hello'])
  })

  test('refuses to send a draft, which can still be previewed and tested', async () => {
    draft = true
    version = 'draft-version'

    expect((await post('/posts/hello/send')).status).toBe(409)
    expect((await post('/posts/hello/preview')).status).toBe(200)
    expect(calls).toEqual([])
  })

  test('answers 404 for a collection the options leave out and for a missing entry', async () => {
    expect((await post('/products/hello/send')).status).toBe(404)
    expect((await post('/posts/missing/send')).status).toBe(404)
    expect(calls).toEqual([])
  })

  test('rejects an option without a list or a message', () => {
    expect(() => configure({ newsletter: { posts: { list: {} as never, message: () => ({}) } } })).toThrow('newsletter')
    expect(() => configure({ newsletter: { posts: { list, message: undefined as never } } })).toThrow('newsletter')
    expect(() => configure({ newsletter: { posts: { list, message: () => ({}), testTo: 3 as never } } })).toThrow('testTo')
  })
})
