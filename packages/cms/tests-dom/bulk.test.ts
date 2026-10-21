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

test('the bar disables the actions the role may not do, with the reason', async () => {
  mounted = await mountComponent('../../tests-dom/with-toaster.kay', { bar: { collection: POSTS, rows: [row('a')], actions: new Set(['publish', 'delete']), clear: () => undefined, denied: { publish: 'Your role may not publish', delete: 'Your role may not delete' } } })
  await settle()

  for (const label of ['Publish', 'Delete']) {
    const control = button(mounted.root, label)!

    expect(control.disabled, label).toBe(true)
    expect(control.closest('[data-tooltip]')?.getAttribute('data-tooltip'), label).toContain('Your role may not')
  }
})

test('a row of the list disables its publish and delete for a role that may not, with the reason', async () => {
  mounted = await mountComponent('../../tests-dom/with-toaster.kay', { table: { collection: POSTS, rows: [row('a')], denied: { publish: 'Your role may not publish', delete: 'Your role may not delete' } } })
  await settle()

  const actions = mounted.root.querySelector('.kcms-row-actions')!
  const refused = [...actions.querySelectorAll('.kcms-refused')]

  expect(refused.map(each => each.getAttribute('data-tooltip'))).toEqual(['Your role may not publish', 'Your role may not delete'])
  expect(refused.every(each => each.querySelector('button')!.disabled)).toBe(true)
})

// The API of a row's Rename dialog: the slugs the collection holds, the entries naming `a`, and the answer to the rename.
function renameServer(answer: object = { saved: true, slug: 'new' }, referrers: string[] = []) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)

    if (init?.method === 'POST')
      return Response.json(answer)

    if (path.includes('/referrers/'))
      return Response.json(referrers.length > 0 ? { a: referrers } : {})

    return Response.json([{ slug: 'a' }, { slug: 'b' }])
  }) as unknown as typeof fetch)
}

const dialogRename = () => [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(item => item.textContent?.trim() === 'Rename')!

async function typeSlug(slug: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('dialog input')!

  input.value = slug
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

test('a row\'s Rename opens the dialog, turns off for a slug the collection holds, and names the version the list read', async () => {
  const fetched = renameServer({ saved: true, slug: 'new' }, ['Books: Engine'])
  const root = await openTable([row('a'), row('b')])

  root.querySelector<HTMLElement>('button[aria-label="Rename a"]')!.click()
  await pause()
  expect(document.querySelector('dialog')!.textContent).toContain('Books: Engine')
  await typeSlug('b')
  expect(dialogRename().disabled).toBe(true)
  expect(document.querySelector('dialog')!.textContent).toContain('already exists')
  await typeSlug('new')
  expect(dialogRename().disabled).toBe(false)
  dialogRename().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await pause()

  const posts = fetched.mock.calls.filter(call => call[1]?.method === 'POST' && String(call[0]).includes('/rename'))

  expect(posts).toHaveLength(1)
  expect(String(posts[0]![0])).toContain('/posts/a/rename')
  expect(String(posts[0]![0])).toContain('version=v-a')
  expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toEqual({ slug: 'new' })
})

test('a row\'s Rename shows the refusal in the dialog, and a role without the redirects role gets it off with the reason', async () => {
  renameServer({ saved: false, issues: [{ message: 'The saver is down' }] })

  const root = await openTable([row('a')])

  root.querySelector<HTMLElement>('button[aria-label="Rename a"]')!.click()
  await pause()
  await typeSlug('new')
  dialogRename().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await pause()
  expect(document.querySelector('dialog[open]')!.textContent).toContain('The saver is down')
  mounted?.unmount()

  mounted = await mountComponent('../../tests-dom/with-toaster.kay', { table: { collection: POSTS, rows: [row('a')], denied: { redirects: 'Your role may not redirect' } } })
  await settle()

  const refused = mounted.root.querySelector('.kcms-row-actions [data-tooltip="Your role may not redirect"]')

  expect(refused?.querySelector('button')?.disabled).toBe(true)
})

test('a rename that left an entry unpointed tells which', async () => {
  renameServer({ saved: true, slug: 'new', unpointed: ['Books: Engine'] })
  page.happyDOM.setURL('http://localhost/admin/collections/posts')

  const root = await openTable([row('a')])

  root.querySelector<HTMLElement>('button[aria-label="Rename a"]')!.click()
  await pause()
  await typeSlug('new')
  dialogRename().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await pause()
  expect(text()).toContain('Renamed, but Books: Engine could not be pointed at the new slug')
})
