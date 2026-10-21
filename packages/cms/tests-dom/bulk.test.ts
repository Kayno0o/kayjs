import type { Mounted } from 'kay/test'
import type { ScreenCollection } from '../src/kay/contract'
import type { EntryRow } from '../src/listing'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const POSTS: ScreenCollection = {
  name: 'posts',
  kind: 'folder',
  localized: false,
  components: [],
  draftField: 'draft',
  schema: { type: 'object', properties: { title: { type: 'string' }, draft: { type: 'boolean' } } },
}
let mounted: Mounted | undefined
const page = window as unknown as { happyDOM: { setURL: (url: string) => void } }
const startedAt = window.location.href

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
  page.happyDOM.setURL(startedAt)
})

const text = () => document.body.textContent
const row = (slug: string, more: Partial<EntryRow> = {}): EntryRow => ({ slug, title: slug, draft: true, version: `v-${slug}`, ...more })

interface Seen {
  method: string
  url: URL
}

// The entries API answering each call with what `answer` says for its slug, and the calls it saw, with how many ran at once at most.
function server(answer: (slug: string, call: Seen) => Response | Promise<Response>) {
  const calls: Seen[] = []
  let running = 0
  let widest = 0

  spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const seen = { method: init?.method ?? 'GET', url }

    calls.push(seen)
    running++
    widest = Math.max(widest, running)

    try {
      await Bun.sleep(2)

      return await answer(url.pathname.split('/')[url.pathname.split('/').indexOf('posts') + 1]!, seen)
    }
    finally {
      running--
    }
  }) as unknown as typeof fetch)

  return { calls, widest: () => widest }
}

const refusing = (message: string) => Response.json({ issues: [{ collection: 'posts', slug: 'x', path: '', message }] })

async function openBar(rows: EntryRow[], actions = ['publish', 'unpublish', 'delete']) {
  const cleared = mock(() => undefined)

  mounted = await mountComponent('../../tests-dom/with-toaster.kay', { bar: { collection: POSTS, rows, actions: new Set(actions), clear: cleared } })
  await settle()

  return { root: mounted.root, cleared }
}

const button = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === label)

async function pause(): Promise<void> {
  for (let wait = 0; wait < 15; wait++) {
    await Bun.sleep(5)
    await settle()
  }
}

test('the bar offers only the actions the ticked rows fit, and a failed row says why in one toast', async () => {
  server(slug => slug === 'b' ? refusing('b changed since you opened it') : Response.json({ saved: true }))

  const { root, cleared } = await openBar([row('a'), row('b'), row('live', { draft: false })])

  expect(button(root, 'Publish')).toBeDefined()
  expect(button(root, 'Unpublish')).toBeDefined()
  button(root, 'Publish')!.click()
  await pause()

  expect(text()).toContain('1 entry published')
  expect(text()).toContain('1 entry could not be changed: b changed since you opened it')
  expect(cleared).toHaveBeenCalledTimes(1)
})

test('a toast counts the failures and names the first reason when several fail', async () => {
  server(() => refusing('nope'))

  const { root } = await openBar([row('a'), row('b')])

  button(root, 'Publish')!.click()
  await pause()
  expect(text()).toContain('2 entries could not be changed, the first: nope')
})

test('a failure no answer explained is only counted', async () => {
  spyOn(globalThis, 'fetch').mockImplementation((async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch)

  const { root } = await openBar([row('a')])

  button(root, 'Publish')!.click()
  await pause()
  expect(text()).toContain('1 entry could not be changed')
  expect(text()).not.toContain('1 entry could not be changed:')
})

test('a bulk delete names each row\'s version and runs the rows in turn', async () => {
  const { calls, widest } = server(() => Response.json({ saved: true }))
  const { root } = await openBar([row('a'), row('b')])

  button(root, 'Delete')!.click()
  await pause()
  // The confirmation, whose own button deletes.
  ;[...document.querySelectorAll('button')].filter(item => item.textContent?.trim() === 'Delete').at(-1)!.click()
  await pause()

  const deletes = calls.filter(call => call.method === 'DELETE')

  expect(deletes.map(call => [call.url.pathname.split('/').at(-1), call.url.searchParams.get('version')])).toEqual([['a', 'v-a'], ['b', 'v-b']])
  expect(widest()).toBe(1)
  expect(text()).toContain('2 entries deleted')
})

async function openTable(rows: EntryRow[]) {
  mounted = await mountComponent('../../tests-dom/with-toaster.kay', { table: { collection: POSTS, rows } })
  await settle()

  return mounted.root
}

test('a duplicate refused says why, and one that failed says the refusal the server gave', async () => {
  server(slug => slug === 'a' ? refusing('posts holds one entry') : new Response('You may not duplicate here', { status: 403 }))

  const root = await openTable([row('a'), row('b')])

  root.querySelector<HTMLElement>('button[aria-label="Duplicate a"]')!.click()
  await pause()
  expect(text()).toContain('Not duplicated: posts holds one entry')

  root.querySelector<HTMLElement>('button[aria-label="Duplicate b"]')!.click()
  await pause()
  expect(text()).toContain('You may not duplicate here')
})

test('a duplicate that went through is told', async () => {
  const { calls } = server(() => Response.json({ saved: true, slug: 'a-copy' }))

  // The copy is opened on its own screen, which needs a page to navigate from.
  page.happyDOM.setURL('http://localhost/admin/collections/posts')
  const root = await openTable([row('a')])

  root.querySelector<HTMLElement>('button[aria-label="Duplicate a"]')!.click()
  await pause()
  expect(text()).toContain('Duplicated')
  expect(calls.map(call => [call.method, call.url.pathname.split('/').slice(-3).join('/')])).toContainEqual(['POST', 'posts/a/duplicate'])
})
