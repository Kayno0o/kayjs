import type { Mounted } from 'kay/test'
import { join } from 'node:path'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const EDITOR = join(import.meta.dir, '../src/editor/editor.kay')
const POSTS = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], draftField: 'draft', schema: { type: 'object', properties: { title: { type: 'string' }, draft: { type: 'boolean' } } } }
const SETTINGS = { name: 'index', title: 'Home', single: true, kind: 'file', localized: false, components: [], schema: { type: 'object', properties: { title: { type: 'string' } } } }
const PLAIN = { name: 'notes', title: 'Notes', kind: 'folder', localized: false, components: [], schema: { type: 'object', properties: { title: { type: 'string' } } } }
let mounted: Mounted | undefined

Object.assign(document, { caretPositionFromPoint: () => null, elementsFromPoint: () => [] })

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
  localStorage.clear()
})

interface Options { collection?: object, draft?: boolean, denied?: Record<string, string>, save?: Response, locale?: string, referrers?: Record<string, string[]> }

// The entries API holding one entry, answering the role's limits and recording every write.
function server({ collection = POSTS, draft = true, denied = {}, save, locale, referrers = {} }: Options = {}) {
  const writes: { method: string, url: string, body?: { data: Record<string, unknown> } }[] = []
  const stored = { slug: 'hello', locale, data: { title: 'Hello', draft }, draft, version: 'v1', url: '/posts/hello' }

  spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url)
    const method = init?.method ?? 'GET'

    if (path.includes('/can'))
      return Response.json({ denied })

    if (path.includes('/referrers'))
      return Response.json(referrers)

    if (method === 'GET')
      return Response.json({ collection, entry: stored })

    if (path.includes('/entries/'))
      writes.push({ method, url: path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })

    return method === 'POST' && save ? save.clone() : Response.json({ saved: true, version: 'v2' })
  }) as unknown as typeof fetch)

  return writes
}

async function open(entry: object = { collection: 'posts', slug: 'hello' }): Promise<ParentNode> {
  mounted = await mountComponent(EDITOR, { entries: [entry], unclickable: [] })
  await settle()
  await Bun.sleep(50)

  return mounted.root
}

const head = (root: ParentNode) => root.querySelector('.kcms-entry-more') ?? root
const button = (root: ParentNode, label: string) => [...head(root).querySelectorAll('button')].find(each => each.textContent?.trim() === label)
const labels = (root: ParentNode) => [...head(root).querySelectorAll('button')].map(each => each.textContent?.trim())

test('a draft entry offers Publish, which saves it published and turns the button into Unpublish', async () => {
  const writes = server()
  const root = await open()

  expect(button(root, 'Publish')).toBeDefined()
  expect(button(root, 'Unpublish')).toBeUndefined()

  button(root, 'Publish')!.click()
  await settle()
  await Bun.sleep(50)

  expect(writes.filter(write => write.method === 'POST').map(write => write.body?.data.draft)).toEqual([false])
  expect(button(root, 'Publish')).toBeUndefined()
  expect(button(root, 'Unpublish')).toBeDefined()
})

test('a published entry offers Unpublish behind a confirmation, which saves it as a draft', async () => {
  const writes = server({ draft: false })
  const root = await open()

  button(root, 'Unpublish')!.click()
  await settle()
  expect(writes).toEqual([])

  const confirm = [...document.querySelectorAll('button')].filter(each => each.textContent?.trim() === 'Unpublish').at(-1)!

  confirm.click()
  await settle()
  await Bun.sleep(50)

  expect(writes.map(write => write.body?.data.draft)).toEqual([true])
})

test('Publish with edits not saved refuses and writes nothing', async () => {
  const writes = server()
  const root = await open()
  const title = root.querySelector<HTMLInputElement>('input')!

  title.value = 'Mine'
  title.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  button(root, 'Publish')!.click()
  await settle()

  expect(writes).toEqual([])
  expect(button(root, 'Publish')).toBeDefined()
})

test('a publish the server refuses leaves the entry a draft in the form', async () => {
  server({ save: Response.json({ error: 'no' }, { status: 500 }) })

  const root = await open()

  button(root, 'Publish')!.click()
  await settle()
  await Bun.sleep(50)

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

test('Delete asks first, names the version and the locale it deletes, and the page is read again after', async () => {
  const writes = server({ locale: 'fr' })
  const root = await open({ collection: 'posts', slug: 'hello', locale: 'fr' })

  button(root, 'Delete')!.click()
  await settle()
  expect(writes).toEqual([])

  const confirm = [...document.querySelectorAll('button')].filter(each => each.textContent?.trim() === 'Delete').at(-1)!

  confirm.click()
  await settle()
  await Bun.sleep(50)

  expect(writes.map(write => write.method)).toEqual(['DELETE'])

  const url = new URL(writes[0]!.url, 'http://localhost')

  expect(url.pathname.endsWith('/entries/posts/hello')).toBe(true)
  expect(url.searchParams.get('locale')).toBe('fr')
  expect(url.searchParams.get('version')).toBe('v1')
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
  const root = await open()

  button(root, 'Publish')!.click()
  await settle()
  await Bun.sleep(50)
  button(root, 'Delete')!.click()
  await settle()
  await Bun.sleep(50)
  expect(document.body.textContent).toContain('Pages: About')

  const confirm = [...document.querySelectorAll('button')].filter(each => each.textContent?.trim() === 'Delete').at(-1)!

  confirm.click()
  await settle()
  await Bun.sleep(50)

  const deleted = writes.find(write => write.method === 'DELETE')!

  expect(new URL(deleted.url, 'http://localhost').searchParams.get('version')).toBe('v2')
})

test('Unpublish with edits not saved refuses without opening a confirmation or writing', async () => {
  const writes = server({ draft: false })
  const root = await open()
  const title = root.querySelector<HTMLInputElement>('input')!

  title.value = 'Mine'
  title.dispatchEvent(new Event('input', { bubbles: true }))
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
