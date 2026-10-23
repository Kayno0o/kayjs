import type { Mounted } from 'kay/test'
import { join } from 'node:path'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { sameBar } from '../src/editor/image-bar'
import { EDITOR_COOKIE } from '../src/page-link'

const EDITOR = join(import.meta.dir, '../src/editor/editor.kay')
const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    photo: { 'type': 'string', 'x-kay': { kind: 'image', width: 'photoWidth', height: 'photoHeight' } },
    photoWidth: { type: 'number' },
    photoHeight: { type: 'number' },
    logo: { 'type': 'string', 'x-kay': { kind: 'image', accept: ['image/png'] } },
    gallery: { type: 'array', items: { type: 'object', properties: { image: { 'type': 'string', 'x-kay': { kind: 'image' } } } } },
  },
}
const POSTS = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], schema: SCHEMA }
const HELLO = { collection: 'posts', slug: 'hello' }
const OTHER = { collection: 'posts', slug: 'other' }
let mounted: Mounted | undefined
let uploads = 0
let refuse = false
// How long an upload takes, and the status a refused one answers.
let slow = 0
let refusal = 415
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
  refuse = false
  slow = 0
  refusal = 415
  document.cookie = `${EDITOR_COOKIE}=; max-age=0`
})

function server(): void {
  document.cookie = `${EDITOR_COOKIE}=tester`
  uploads = 0
  asked = []
  spyOn(globalThis, 'fetch').mockImplementation((async (request: string | URL | Request, init?: RequestInit) => {
    const path = String(request)

    asked.push(path)

    if (path.includes('/can'))
      return Response.json({ denied: {}, prefix: '/admin' })

    if (path.includes('/rules'))
      return Response.json({ accept: 'image/*', images: 'image/*', maxSize: 1_000_000 })

    if (init?.method === 'POST' && path.includes('/files/')) {
      uploads++
      await Bun.sleep(slow)

      return refuse ? Response.json({ error: 'Not an image' }, { status: refusal }) : Response.json({ path: '/_kay/files/posts/new.png', width: 640, height: 480 })
    }

    if (init?.method === 'POST')
      return Response.json({})

    return Response.json({ collection: POSTS, entry: { slug: 'hello', data: { title: 'Hello', photo: '/old.png', photoWidth: 10, photoHeight: 10, gallery: [{ image: '/a.png' }, { image: '/b.png' }] }, version: 'v1', url: '/posts/hello' } })
  }) as unknown as typeof fetch)
}

// The edits the editor kept in the browser for the entry, which is how a test outside its bundle reads its drafts.
function data(): Record<string, unknown> {
  const kept = localStorage.getItem('kcms:draft:tester:posts:hello')

  return kept === null ? {} : (JSON.parse(kept) as { entry: { data: Record<string, unknown> } }).entry.data
}

async function until(done: () => boolean): Promise<void> {
  const giveUp = Date.now() + 5000

  while (Date.now() < giveUp) {
    await settle()

    if (done())
      return
  }

  throw new Error('the page never reached the state the test waits for')
}

async function open(entries: object[] = [HELLO]) {
  const image = document.createElement('img')
  const title = document.createElement('h1')

  image.dataset.page = ''
  image.setAttribute('data-kay-field-src', 'posts:hello:photo')
  title.dataset.page = ''
  title.setAttribute('data-kay-field', 'posts:hello:title')
  title.textContent = 'Hello'
  Object.assign(image, { getBoundingClientRect: () => ({ left: 10, top: 10, right: 310, bottom: 210, width: 300, height: 200 }) })
  document.body.append(image, title)
  mounted = await mountComponent(EDITOR, { entries, unclickable: [] })
  await settle()
  await Bun.sleep(30)

  return { root: mounted.root, image, title }
}

const bar = (root: Element) => root.querySelector('[data-kcms-image-bar] button')
const file = () => new File(['x'], 'new.png', { type: 'image/png' })

function drop(target: Element, files: File[]): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true })

  Object.assign(event, { dataTransfer: { files, types: ['Files'] } })
  target.dispatchEvent(event)

  return event
}

test('the pointer over a marked image offers to replace it, and leaving it takes the button away', async () => {
  server()

  const { root, image, title } = await open()

  expect(bar(root)).toBeNull()
  image.dispatchEvent(new Event('pointerover', { bubbles: true }))
  await until(() => bar(root) !== null)
  expect(bar(root)?.getAttribute('aria-label')).toBe('Replace Photo')
  expect(root.querySelector<HTMLElement>('[data-kcms-image-bar]')?.style.left).toBe('262px')
  title.dispatchEvent(new Event('pointerover', { bubbles: true }))
  await until(() => bar(root) === null)
})

test('the button stays while the pointer moves onto it', async () => {
  server()

  const { root, image } = await open()

  image.dispatchEvent(new Event('pointerover', { bubbles: true }))
  await until(() => bar(root) !== null)
  bar(root)?.dispatchEvent(new Event('pointerover', { bubbles: true }))
  await settle()
  expect(bar(root)).not.toBeNull()
})

test('a text field shows no button', async () => {
  server()

  const { root, title } = await open()

  title.dispatchEvent(new Event('pointerover', { bubbles: true }))
  await settle()
  expect(bar(root)).toBeNull()
})

test('a file picked uploads and becomes the image, with its size', async () => {
  server()

  const { root, image } = await open()

  image.dispatchEvent(new Event('pointerover', { bubbles: true }))
  await until(() => bar(root) !== null)
  ;(bar(root) as HTMLButtonElement).click()

  const picker = root.querySelector<HTMLInputElement>('.kcms-page-images input[type=file]')!

  Object.defineProperty(picker, 'files', { value: [file()], configurable: true })
  picker.dispatchEvent(new Event('change', { bubbles: true }))
  await until(() => data().photo === '/_kay/files/posts/new.png')

  expect(uploads).toBe(1)
  expect(data()).toMatchObject({ photoWidth: 640, photoHeight: 480 })
})

test('a file dropped on the image replaces it, and one dropped elsewhere does not', async () => {
  server()

  const { image, title } = await open()

  expect(drop(title, [file()]).defaultPrevented).toBe(false)
  await settle()
  expect(uploads).toBe(0)
  expect(drop(image, [file()]).defaultPrevented).toBe(true)
  await until(() => data().photo === '/_kay/files/posts/new.png')
  expect(uploads).toBe(1)
})

test('a file dragged over the image is accepted there and marks it, over text it is not', async () => {
  server()

  const { image, title } = await open()
  const over = (target: Element) => {
    const event = new Event('dragover', { bubbles: true, cancelable: true })

    Object.assign(event, { dataTransfer: { files: [], types: ['Files'] } })
    target.dispatchEvent(event)

    return event
  }

  expect(over(title).defaultPrevented).toBe(false)
  expect(over(image).defaultPrevented).toBe(true)
  expect(image.hasAttribute('data-kcms-dropping')).toBe(true)
  over(title)
  expect(image.hasAttribute('data-kcms-dropping')).toBe(false)
})

test('a refused file changes no draft', async () => {
  server()
  refuse = true

  const { image } = await open()

  drop(image, [file()])
  await until(() => uploads === 1)
  await settle()
  expect(data().photo).toBeUndefined()
})

// Another image of the page, marked for a field of the entry.
function markedImage(path: string, entry = 'hello'): HTMLImageElement {
  const image = document.createElement('img')

  image.dataset.page = ''
  image.setAttribute('data-kay-field-src', `posts:${entry}:${path}`)
  Object.assign(image, { getBoundingClientRect: () => ({ left: 10, top: 10, right: 310, bottom: 210, width: 300, height: 200 }) })
  document.body.append(image)

  return image
}

const gif = () => new File(['x'], 'new.gif', { type: 'image/gif' })

test('a file the field does not accept is refused before the upload, in the form\'s words', async () => {
  server()

  const { root } = await open()
  const logo = markedImage('logo')

  drop(logo, [gif()])
  await until(() => document.body.textContent.includes('new.gif is image/gif that uploads here do not take: image/png') || root.textContent.includes('new.gif is image/gif'))
  expect(uploads).toBe(0)
  expect(data().logo).toBeUndefined()
  drop(logo, [file()])
  await until(() => data().logo === '/_kay/files/posts/new.png')
  expect(uploads).toBe(1)
})

test('a file the server\'s image types miss is refused before the upload when the field names none', async () => {
  server()

  const { image } = await open()

  drop(image, [new File(['x'], 'doc.pdf', { type: 'application/pdf' })])
  await until(() => document.body.textContent.includes('doc.pdf is application/pdf that uploads here do not take: image/*'))
  expect(uploads).toBe(0)
})

test('a file dropped on an image of an entry still a row is kept from the browser, opens the entry and replaces the image once it has loaded', async () => {
  server()

  const { image } = await open([OTHER, HELLO])
  const over = new Event('dragover', { bubbles: true, cancelable: true })

  Object.assign(over, { dataTransfer: { files: [], types: ['Files'] } })
  image.dispatchEvent(over)
  expect(over.defaultPrevented).toBe(true)
  expect(drop(image, [file()]).defaultPrevented).toBe(true)
  await until(() => data().photo === '/_kay/files/posts/new.png')
  expect(asked.filter(path => path.includes('/entries/') && path.includes('/posts/hello'))).toHaveLength(1)
  expect(asked.some(path => path.includes('/posts/other'))).toBe(false)
  expect(uploads).toBe(1)
})

function gallery(): HTMLImageElement[] {
  const list = document.createElement('ul')

  list.dataset.page = ''
  list.setAttribute('data-kay-list', 'posts:hello:gallery')
  document.body.append(list)

  return ['gallery.0.image', 'gallery.1.image'].map((path) => {
    const item = document.createElement('li')
    const image = markedImage(path)

    item.append(image)
    list.append(item)

    return image
  })
}

function keyDown(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, shiftKey: true, bubbles: true, cancelable: true }))
}

test('an image of a list item lands in its item, whose page bars cannot move it while the upload is under way', async () => {
  server()
  slow = 150

  await open()
  const [, second] = gallery()

  await settle()
  drop(second!, [file()])
  await Bun.sleep(30)
  keyDown(second!, 'ArrowUp')
  keyDown(second!, 'Delete')
  await until(() => (data().gallery as { image: string }[] | undefined)?.[1]?.image === '/_kay/files/posts/new.png')
  expect(data().gallery).toEqual([{ image: '/a.png' }, { image: '/_kay/files/posts/new.png' }])
})

test('a list item moves again once its image has landed', async () => {
  server()

  await open()
  const [, second] = gallery()

  await settle()
  drop(second!, [file()])
  await until(() => (data().gallery as { image: string }[] | undefined)?.[1]?.image === '/_kay/files/posts/new.png')
  keyDown(second!, 'ArrowUp')
  await until(() => (data().gallery as { image: string }[] | undefined)?.[0]?.image === '/_kay/files/posts/new.png')
})

test('a session that ended during the upload of a list item\'s image toasts it and changes no draft', async () => {
  server()
  refuse = true
  refusal = 401
  slow = 50

  const { root } = await open()
  const [, second] = gallery()

  await settle()
  drop(second!, [file()])
  await until(() => document.body.textContent.includes('Your session has ended') || root.textContent.includes('Your session has ended'))
  expect(data().gallery).toBeUndefined()
})

test('a bar that moved nothing is the same bar, one that moved or names another image is not', () => {
  const bar = { entry: HELLO, path: 'photo', label: 'Photo', accept: undefined, style: 'left: 1px; top: 2px' }

  expect(sameBar(bar, { ...bar, entry: { ...HELLO } })).toBe(true)
  expect(sameBar(bar, { ...bar, style: 'left: 2px; top: 2px' })).toBe(false)
  expect(sameBar(bar, { ...bar, path: 'logo' })).toBe(false)
  expect(sameBar(bar, undefined)).toBe(false)
  expect(sameBar(undefined, undefined)).toBe(true)
})
