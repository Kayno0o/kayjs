import type { Mounted } from 'kay/test'
import { join } from 'node:path'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const EDITOR = join(import.meta.dir, '../src/editor/editor.kay')
const POSTS = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], schema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } }
const HOME = { name: 'home', title: 'Home page', single: true, kind: 'file', localized: false, components: [], schema: { type: 'object', properties: { headline: { type: 'string' }, tagline: { type: 'string' } } } }
const HELLO = { collection: 'posts', slug: 'hello' }
const HOME_ENTRY = { collection: 'home', slug: 'index' }
let mounted: Mounted | undefined
let asked: string[] = []

Object.assign(document, { caretPositionFromPoint: () => null, elementsFromPoint: () => [] })

afterEach(async () => {
  await Bun.sleep(20)
  mounted?.unmount()
  mounted = undefined
  for (const element of document.querySelectorAll('[data-page]'))
    element.remove()
  mock.restore()
  localStorage.clear()
})

interface Write { url: string, data: Record<string, unknown> }

// The entries API holding a post and the home page, recording every save; `refuse` answers a save of that collection with an issue on a field.
function server(refuse?: { collection: string, path: string }, posts: object = POSTS) {
  const writes: Write[] = []

  asked = []
  spyOn(globalThis, 'fetch').mockImplementation((async (request: string | URL | Request, init?: RequestInit) => {
    const path = String(request)
    const method = init?.method ?? 'GET'

    asked.push(path)

    if (path.includes('/can'))
      return Response.json({ denied: {}, prefix: '/admin' })

    if (method === 'GET' && path.includes('/entries/')) {
      return path.includes('/home/')
        ? Response.json({ collection: HOME, entry: { slug: 'index', data: { headline: 'Welcome', tagline: 'Hi' }, version: 'v1', url: '/' } })
        : Response.json({ collection: posts, entry: { slug: 'hello', data: { title: 'Hello world', summary: 'Short', tags: ['a'], seo: { description: 'D', image: 'i.png' } }, version: 'v1', url: '/posts/hello' } })
    }

    if (method === 'POST' && path.includes('/entries/')) {
      writes.push({ url: path, data: (JSON.parse(String(init?.body)) as { data: Record<string, unknown> }).data })

      if (refuse && path.includes(`/${refuse.collection}/`))
        return Response.json({ issues: [{ path: refuse.path, message: 'Not valid' }] })

      return Response.json({ saved: true, version: 'v2' })
    }

    return Response.json({ saved: true })
  }) as unknown as typeof fetch)

  return writes
}

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

async function open(entries: object[] = [HELLO]) {
  // The fields a visitor clicks on the page.
  for (const marker of ['posts:hello:summary', 'posts:hello:title', 'posts:hello:tags', 'posts:hello:seo.description']) {
    const element = document.createElement('p')

    element.dataset.page = ''
    element.setAttribute('data-kay-field', marker)
    // Styled text is not typed in place, which a plain one would be: summary is brought up in the form.
    element.innerHTML = marker === 'posts:hello:summary' ? 'S<em>hort</em>' : marker
    document.body.append(element)
  }

  mounted = await mountComponent(EDITOR, { entries, unclickable: [] })

  const root = mounted.root

  await until(() => root.querySelectorAll('.kcms-entry-loading').length === 0 && root.querySelector('.kcms-entry') !== null && asked.some(path => path.includes('/can')))
  await settle()

  const path = (name: string) => root.querySelector<HTMLInputElement>(`[data-kcms-path="${name}"] input`)!
  // The field items of the first form that are shown.
  const shown = () => [...root.querySelectorAll('.kcms-entry:first-of-type .kcms-item')].filter(item => !item.hasAttribute('hidden')).map(item => item.querySelector('[data-kcms-path]')?.getAttribute('data-kcms-path'))
  const anchor = (label: string, form = 0) => [...root.querySelectorAll('.kcms-entry')[form]!.querySelectorAll<HTMLElement>('.kcms-entry-anchors button')].find(each => each.textContent?.trim() === label)!
  const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(each => each.textContent?.trim() === label)
  const type = async (input: HTMLInputElement, value: string) => {
    input.focus()
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }

  return { root, path, shown, anchor, button, type }
}

const page = (marker: string) => document.querySelector<HTMLElement>(`[data-kay-field="${marker}"]`)!

test('the form is titled by the entry and the collection sits under it', async () => {
  server()

  const { root } = await open()

  expect(root.querySelector('.kcms-entry-title')?.textContent).toBe('Hello world')
  expect(root.querySelector('.kcms-entry-collection')?.textContent).toBe('Posts')
})

test('a single collection\'s form is titled by the collection alone', async () => {
  server()

  const { root } = await open([HOME_ENTRY])

  expect(root.querySelector('.kcms-entry-title')?.textContent).toBe('Home page')
  expect(root.querySelector('.kcms-entry-collection')).toBeNull()
})

test('the form starts whole, with an anchor per field and none of them pressed', async () => {
  server()

  const { root, shown } = await open()
  const anchors = [...root.querySelectorAll('.kcms-entry-anchors button')]

  expect(shown()).toEqual(['title', 'summary', 'tags'])
  expect(anchors.map(each => each.textContent?.trim())).toEqual(['Title', 'Summary', 'Tags'])
  expect(anchors.map(each => each.getAttribute('aria-pressed'))).toEqual([null, null, null])
})

test('a click on the page collapses the form to that field and puts the caret in it', async () => {
  server()

  const { path, shown, anchor, button } = await open()

  page('posts:hello:summary').click()
  await until(() => shown().length === 1)

  expect(shown()).toEqual(['summary'])
  expect(document.activeElement).toBe(path('summary'))
  expect(anchor('Summary').getAttribute('aria-pressed')).toBe('true')
  expect(anchor('Title').getAttribute('aria-pressed')).toBe('false')
  expect(button('Show all fields')).toBeDefined()
})

test('typing in a text on the page collapses the form to it and leaves the caret on the page', async () => {
  server()

  const { shown } = await open()

  page('posts:hello:title').click()
  await until(() => shown().length === 1)

  expect(shown()).toEqual(['title'])
  expect(document.activeElement).toBe(page('posts:hello:title'))
})

test('an anchor shows its field alone and focuses it, and Show all fields opens the form again', async () => {
  server()

  const { path, shown, anchor, button } = await open()

  anchor('Tags').click()
  await until(() => shown().length === 1)
  expect(shown()).toEqual(['tags'])
  expect(document.activeElement).toBe(path('tags.0'))

  anchor('Title').click()
  await until(() => shown()[0] === 'title')
  expect(shown()).toEqual(['title'])

  button('Show all fields')!.click()
  await until(() => shown().length === 3)
  expect(button('Show all fields')).toBeUndefined()
})

test('focusing a field of the whole form leaves it whole, so a Tab never hides the next field', async () => {
  server()

  const { path, shown } = await open()

  path('summary').focus()
  await settle()

  expect(shown()).toEqual(['title', 'summary', 'tags'])
})

test('what was typed in a field is kept while it is hidden, and Save writes it with the shown one', async () => {
  const writes = server()
  const { path, shown, anchor, button, type } = await open()

  await type(path('title'), 'Mine')
  anchor('Summary').click()
  await until(() => shown()[0] === 'summary')
  expect(path('title').value).toBe('Mine')

  await type(path('summary'), 'Also mine')
  button('Save')!.click()
  await until(() => writes.length > 0)

  expect(writes.map(write => write.data)).toMatchObject([{ title: 'Mine', summary: 'Also mine', tags: ['a'] }])
})

test('a save refused on a hidden field opens the form on it, and one refused on the shown field keeps it collapsed', async () => {
  const writes = server({ collection: 'posts', path: 'title' })

  const { path, shown, anchor, button, type } = await open()

  await type(path('title'), 'Mine')
  anchor('Summary').click()
  await until(() => shown()[0] === 'summary')
  button('Save')!.click()
  await until(() => shown().length === 3)

  expect(document.activeElement).toBe(path('title'))

  anchor('Title').click()
  await until(() => shown().length === 1)
  button('Save')!.click()
  await until(() => writes.length === 2)
  await settle()

  expect(shown()).toEqual(['title'])
})

test('Save all is offered where the page reads several entries, and saves each one holding edits in the page\'s order', async () => {
  const writes = server()
  const { root, path, button, type } = await open([HELLO, HOME_ENTRY])

  expect(button('Save all')!.disabled).toBe(true)

  await type(root.querySelector<HTMLInputElement>('[data-kcms-path="headline"] input')!, 'New welcome')
  await type(path('title'), 'New title')
  expect(button('Save all')!.disabled).toBe(false)

  button('Save all')!.click()
  await until(() => writes.length === 2)

  expect(writes.map(write => [write.url.includes('/posts/') ? 'posts' : 'home', write.data.title ?? write.data.headline])).toEqual([['posts', 'New title'], ['home', 'New welcome']])
  await until(() => button('Save all')!.disabled)
})

test('Save all leaves a refused entry unsaved with its message and still saves the others', async () => {
  const writes = server({ collection: 'posts', path: 'title' })
  const { root, path, button, type } = await open([HELLO, HOME_ENTRY])

  await type(path('title'), 'New title')
  await type(root.querySelector<HTMLInputElement>('[data-kcms-path="headline"] input')!, 'New welcome')
  button('Save all')!.click()
  await until(() => writes.length === 2)
  await until(() => root.querySelectorAll('.kcms-entry[aria-busy="true"]').length === 0)
  await settle()

  expect(writes.map(write => write.url.includes('/posts/') ? 'posts' : 'home')).toEqual(['posts', 'home'])
  expect(button('Save all')!.disabled).toBe(false)
})

test('a page with one entry has no Save all', async () => {
  server()

  const { button } = await open()

  expect(button('Save all')).toBeUndefined()
})

const WITH_GROUP = { ...POSTS, schema: { type: 'object', properties: { ...POSTS.schema.properties, seo: { type: 'object', properties: { description: { type: 'string' }, image: { type: 'string' } } } } } }

test('a click on a field the layout hides collapses nothing', async () => {
  server(undefined, { ...POSTS, layout: { form: { hide: ['tags'] } } })

  const { root, shown, button } = await open()

  expect(shown()).toEqual(['title', 'summary'])
  page('posts:hello:tags').click()
  await settle()
  await Bun.sleep(30)

  expect(shown()).toEqual(['title', 'summary'])
  expect(button('Show all fields')).toBeUndefined()
  expect(root.querySelectorAll('.kcms-item[hidden]')).toHaveLength(0)
})

test('a field a layout placed is its own item, and its group keeps the rest', async () => {
  server(undefined, { ...WITH_GROUP, layout: { form: { fields: [['title', 'seo.description']] } } })

  const { root, shown, anchor } = await open()

  page('posts:hello:seo.description').click()
  await until(() => shown().length === 1)

  expect(shown()).toEqual(['seo.description'])
  expect([...root.querySelectorAll('.kcms-entry-anchors button')].filter(each => each.getAttribute('aria-pressed') === 'true').map(each => each.textContent?.trim())).toEqual(['Description'])

  anchor('Seo').click()
  await until(() => shown()[0] === 'seo')
  expect(shown()).toEqual(['seo'])
  expect(root.querySelector('[data-kcms-path="seo.image"]')).not.toBeNull()
})

test('Show all fields puts the focus on the anchors', async () => {
  server()

  const { root, anchor, button, shown } = await open()

  anchor('Summary').click()
  await until(() => shown().length === 1)
  button('Show all fields')!.click()
  await until(() => shown().length === 3)

  expect(document.activeElement).toBe(root.querySelector('.kcms-entry-anchors button'))
})

test('the form is not collapsed again by a reload of its entry', async () => {
  server()

  const { shown, anchor, button } = await open()

  page('posts:hello:summary').click()
  await until(() => shown().length === 1)
  button('Show all fields')!.click()
  await until(() => shown().length === 3)
  await Bun.sleep(50)

  expect(shown()).toEqual(['title', 'summary', 'tags'])
  expect(anchor('Title').getAttribute('aria-pressed')).toBeNull()
})

test('the body is an anchor of its own, named as the layout names it', async () => {
  server(undefined, { ...POSTS, body: true, layout: { form: { body: { label: 'Text' } } } })

  const { anchor, shown } = await open()

  anchor('Text').click()
  await until(() => shown()[0] === undefined)

  expect(document.querySelector('.kcms-entry [data-kcms-body]')!.closest('.kcms-item')!.hasAttribute('hidden')).toBe(false)
})

test('Save all with one entry refused leaves it dirty with its message and the other saved', async () => {
  const writes = server({ collection: 'posts', path: 'title' })
  const { root, path, button, type } = await open([HELLO, HOME_ENTRY])
  const save = (form: number) => [...root.querySelectorAll('.kcms-entry')[form]!.querySelectorAll<HTMLButtonElement>('button')].find(each => each.textContent?.trim() === 'Save')!

  await type(path('title'), 'New title')
  await type(root.querySelector<HTMLInputElement>('[data-kcms-path="headline"] input')!, 'New welcome')
  button('Save all')!.click()
  await until(() => writes.length === 2)
  await until(() => root.querySelectorAll('.kcms-entry[aria-busy="true"]').length === 0)
  await settle()

  expect([save(0).disabled, save(1).disabled]).toEqual([false, true])
  expect(root.querySelector('.kcms-entry [data-part="issue"]')?.textContent).toContain('Not valid')
})
