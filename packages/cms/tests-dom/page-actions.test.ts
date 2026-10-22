import type { Mounted } from 'kay/test'
import { join } from 'node:path'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const EDITOR = join(import.meta.dir, '../src/editor/editor.kay')
const POSTS = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], draftField: 'draft', schema: { type: 'object', properties: { title: { type: 'string' }, draft: { type: 'boolean' } } } }
const SETTINGS = { name: 'index', title: 'Home', single: true, kind: 'file', localized: false, components: [], schema: { type: 'object', properties: { title: { type: 'string' } } } }
const PLAIN = { name: 'notes', title: 'Notes', kind: 'folder', localized: false, components: [], schema: { type: 'object', properties: { title: { type: 'string' } } } }
let mounted: Mounted | undefined
// Lets the save a `hold` server keeps waiting go through.
let releaseSave: () => void = () => undefined
// The paths the server was asked for, so a test knows when the role's limits have arrived.
let asked: string[] = []
// Where in `asked` the last write to an entry stands, and whether an edit was typed: each has the page render the draft after a pause.
let lastWrite = -1
let typed = false

Object.assign(document, { caretPositionFromPoint: () => null, elementsFromPoint: () => [] })

const happyDOM = (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM

afterEach(async () => {
  await rendered()
  mounted?.unmount()
  mounted = undefined
  mock.restore()
  localStorage.clear()
  happyDOM.setURL('http://localhost/')
})

interface Options { hold?: boolean, collection?: object, draft?: boolean, denied?: Record<string, string>, save?: Response, locale?: string, referrers?: Record<string, string[]>, url?: string }

// The entries API holding one entry, answering the role's limits and recording every write.
function server({ hold = false, collection = POSTS, draft = true, denied = {}, save, locale, referrers = {}, url = '/posts/hello' }: Options = {}) {
  const held = new Promise<void>((resolve) => {
    releaseSave = resolve
  })
  const writes: { method: string, url: string, body?: { data: Record<string, unknown>, locale?: string } }[] = []
  const stored = { slug: 'hello', locale, data: { title: 'Hello', draft }, draft, version: 'v1', url }

  asked = []
  lastWrite = -1
  spyOn(globalThis, 'fetch').mockImplementation((async (request: string | URL | Request, init?: RequestInit) => {
    const path = String(request)
    const method = init?.method ?? 'GET'

    asked.push(path)

    if (path.includes('/can'))
      return Response.json({ denied, prefix: '/admin' })

    if (path.includes('/referrers'))
      return Response.json(referrers)

    if (method === 'GET')
      return Response.json({ collection, entry: stored })

    if (path.includes('/entries/')) {
      lastWrite = asked.length
      writes.push({ method, url: path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    }

    if (method === 'POST' && hold)
      await held

    return method === 'POST' && save ? save.clone() : Response.json({ saved: true, version: 'v2' })
  }) as unknown as typeof fetch)

  return writes
}

// An edit or a save has the page render the draft after a pause: the request is waited for, or it lands in the next test.
async function rendered(): Promise<void> {
  const from = lastWrite

  if (from < 0 && !typed)
    return

  typed = false

  try {
    await until(() => asked.slice(Math.max(from, 0)).some(path => path.includes('/draft')))
  }
  catch {
    // A change that scheduled no render has nothing to wait for.
  }
}

// Waits for what a click set going to show, the event a test depends on rather than a fixed pause.
async function until(done: () => unknown): Promise<void> {
  const giveUp = Date.now() + 5000

  while (Date.now() < giveUp) {
    await settle()

    const result = done()

    if (result !== undefined && result !== null && result !== false)
      return
  }

  throw new Error('the page never reached the state the test waits for')
}

async function open(entry: object = { collection: 'posts', slug: 'hello' }): Promise<ParentNode> {
  mounted = await mountComponent(EDITOR, { entries: [entry], unclickable: [] })

  const root = mounted.root

  await until(() => root.querySelector('.kcms-entry') !== null && root.querySelector('.kcms-entry-loading') === null && asked.some(path => path.includes('/can')))
  await settle()

  return root
}

const head = (root: ParentNode) => root.querySelector('.kcms-entry-more') ?? root
const button = (root: ParentNode, label: string) => [...head(root).querySelectorAll('button')].find(each => each.textContent?.trim() === label)
const labels = (root: ParentNode) => [...head(root).querySelectorAll('button')].map(each => each.textContent?.trim())

// The address the page was asked to load, which happy-dom is not left to fetch through the mocked server.
function leaving() {
  const assign = spyOn(window.location, 'assign').mockImplementation(() => undefined)

  return async () => {
    await until(() => assign.mock.calls.length > 0)

    return new URL(String(assign.mock.calls[0]![0])).pathname
  }
}

const confirmation = (label: string) => [...document.querySelectorAll('button')].filter(each => each.textContent?.trim() === label).at(-1)!

test('a draft entry offers Publish, which saves it published and turns the button into Unpublish', async () => {
  const writes = server()
  const root = await open()

  expect(button(root, 'Publish')).toBeDefined()
  expect(button(root, 'Unpublish')).toBeUndefined()

  button(root, 'Publish')!.click()
  await until(() => button(root, 'Unpublish'))

  expect(writes.filter(write => write.method === 'POST').map(write => write.body?.data.draft)).toEqual([false])
  expect(button(root, 'Publish')).toBeUndefined()
})

test('a published entry offers Unpublish behind a confirmation, which saves it as a draft', async () => {
  const writes = server({ draft: false })
  const root = await open()

  button(root, 'Unpublish')!.click()
  await until(() => confirmation('Unpublish') !== button(root, 'Unpublish'))
  expect(writes).toEqual([])

  confirmation('Unpublish').click()
  await until(() => writes.length > 0)

  expect(writes.map(write => write.body?.data.draft)).toEqual([true])
})

test('Publish with edits not saved refuses and writes nothing', async () => {
  const writes = server()
  const root = await open()
  const title = root.querySelector<HTMLInputElement>('input')!

  title.value = 'Mine'
  title.dispatchEvent(new Event('input', { bubbles: true }))
  typed = true
  await settle()
  button(root, 'Publish')!.click()
  await settle()

  expect(writes).toEqual([])
  expect(button(root, 'Publish')).toBeDefined()
})

test('a publish the server refuses leaves the entry a draft in the form', async () => {
  const writes = server({ save: Response.json({ error: 'no' }, { status: 500 }) })
  const root = await open()

  button(root, 'Publish')!.click()
  await until(() => writes.length > 0)
  await settle()

  expect(button(root, 'Publish')).toBeDefined()
  expect(button(root, 'Unpublish')).toBeUndefined()
})

test('a role that may not publish sees Publish disabled with the reason', async () => {
  const writes = server({ denied: { publish: 'Your role may not publish' } })
  const root = await open()
  const refused = head(root).querySelector('.kcms-refused')!

  expect(refused.getAttribute('data-tooltip')).toBe('Your role may not publish')
  expect(refused.querySelector('button')!.disabled).toBe(true)
  expect(writes).toEqual([])
})

test('a collection with no draft flag offers neither Publish nor Unpublish', async () => {
  server({ collection: PLAIN })

  const root = await open({ collection: 'notes', slug: 'hello' })

  expect(labels(root)).not.toContain('Publish')
  expect(labels(root)).not.toContain('Unpublish')
})

test('Publish on a localized entry sends its locale', async () => {
  const writes = server({ locale: 'fr', url: '/fr/posts/hello' })
  const root = await open({ collection: 'posts', slug: 'hello', locale: 'fr' })

  button(root, 'Publish')!.click()
  await until(() => writes.length > 0)

  expect(writes[0]!.body?.locale).toBe('fr')
})

test('Delete asks first, names the version and the locale it deletes, and the page is read again after', async () => {
  const writes = server({ locale: 'fr' })
  const reload = spyOn(window.location, 'reload').mockImplementation(() => undefined)

  happyDOM.setURL('http://localhost/other')

  const root = await open({ collection: 'posts', slug: 'hello', locale: 'fr' })

  button(root, 'Delete')!.click()
  await settle()
  expect(writes).toEqual([])

  confirmation('Delete').click()
  await until(() => reload.mock.calls.length > 0)

  expect(writes.map(write => write.method)).toEqual(['DELETE'])

  const url = new URL(writes[0]!.url, 'http://localhost')

  expect(url.pathname.endsWith('/entries/posts/hello')).toBe(true)
  expect(url.searchParams.get('locale')).toBe('fr')
  expect(url.searchParams.get('version')).toBe('v1')
  expect(window.location.pathname).toBe('/other')
})

test('a single entry cannot be deleted from the page, a role that may not delete sees it disabled with the reason', async () => {
  server({ collection: SETTINGS })
  expect(labels(await open({ collection: 'index', slug: 'index' }))).not.toContain('Delete')
  mounted?.unmount()
  mock.restore()
  server({ denied: { delete: 'Your role may not delete' } })

  const root = await open()
  const refused = head(root).querySelectorAll('.kcms-refused')

  expect([...refused].map(each => each.getAttribute('data-tooltip'))).toContain('Your role may not delete')
})

test('Delete after a save names the version that save left, and the confirmation names the entries referring to it', async () => {
  const writes = server({ referrers: { hello: ['Pages: About'] } })
  const reload = spyOn(window.location, 'reload').mockImplementation(() => undefined)
  const root = await open()

  button(root, 'Publish')!.click()
  await until(() => button(root, 'Unpublish'))
  button(root, 'Delete')!.click()
  await until(() => document.body.textContent.includes('Pages: About'))
  confirmation('Delete').click()
  await until(() => reload.mock.calls.length > 0)

  const deleted = writes.find(write => write.method === 'DELETE')!

  expect(new URL(deleted.url, 'http://localhost').searchParams.get('version')).toBe('v2')
})

test('Delete from the entry\'s own page leads to the collection\'s screen, not to the page it removed, and locks the form meanwhile', async () => {
  const writes = server()
  const reload = spyOn(window.location, 'reload').mockImplementation(() => undefined)
  const leftFor = leaving()

  happyDOM.setURL('http://localhost/posts/hello')

  const root = await open()

  button(root, 'Delete')!.click()
  await settle()
  confirmation('Delete').click()
  expect(await leftFor()).toBe('/admin/collections/posts')
  expect(writes.map(write => write.method)).toEqual(['DELETE'])
  expect(reload).not.toHaveBeenCalled()
  expect(root.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true)
  expect(([...root.querySelectorAll('.kcms-entry-actions button')].find(each => each.textContent?.trim() === 'Save') as HTMLButtonElement).disabled).toBe(true)
  expect((button(root, 'Publish') as HTMLButtonElement).disabled).toBe(true)
})

test('Delete from the entry\'s own page counts a trailing slash and escaped characters as the same page', async () => {
  server({ url: '/posts/héllo' })
  const leftFor = leaving()

  happyDOM.setURL('http://localhost/posts/h%C3%A9llo/')

  const root = await open()

  button(root, 'Delete')!.click()
  await settle()
  confirmation('Delete').click()
  expect(await leftFor()).toBe('/admin/collections/posts')
})

test('Delete of a localized entry from its own page leads to the collection\'s screen', async () => {
  const writes = server({ locale: 'fr', url: '/fr/posts/hello' })
  const leftFor = leaving()

  happyDOM.setURL('http://localhost/fr/posts/hello')

  const root = await open({ collection: 'posts', slug: 'hello', locale: 'fr' })

  button(root, 'Delete')!.click()
  await settle()
  confirmation('Delete').click()
  expect(await leftFor()).toBe('/admin/collections/posts')
  expect(new URL(writes[0]!.url, 'http://localhost').searchParams.get('locale')).toBe('fr')
})

test('Unpublish with edits not saved refuses without opening a confirmation or writing', async () => {
  const writes = server({ draft: false })
  const root = await open()
  const title = root.querySelector<HTMLInputElement>('input')!

  title.value = 'Mine'
  title.dispatchEvent(new Event('input', { bubbles: true }))
  typed = true
  await settle()
  button(root, 'Unpublish')!.click()
  await settle()

  expect(writes).toEqual([])
  expect(button(root, 'Unpublish')).toBeDefined()
})

test('a single collection with no draft flag shows no row of actions', async () => {
  server({ collection: SETTINGS })

  const root = await open({ collection: 'index', slug: 'index' })

  expect(root.querySelector('.kcms-entry-more')).toBeNull()
})

test('Delete waits while a save runs', async () => {
  server({ hold: true })

  const root = await open()

  button(root, 'Publish')!.click()
  await until(() => button(root, 'Delete')!.disabled)

  releaseSave()
  await until(() => !button(root, 'Delete')!.disabled)
})
