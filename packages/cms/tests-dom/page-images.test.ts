import type { Mounted } from 'kay/test'
import { join } from 'node:path'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { EDITOR_COOKIE } from '../src/page-link'

const EDITOR = join(import.meta.dir, '../src/editor/editor.kay')
const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    photo: { 'type': 'string', 'x-kay': { kind: 'image', width: 'photoWidth', height: 'photoHeight' } },
    photoWidth: { type: 'number' },
    photoHeight: { type: 'number' },
  },
}
const POSTS = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], schema: SCHEMA }
const HELLO = { collection: 'posts', slug: 'hello' }
let mounted: Mounted | undefined
let uploads = 0
let refuse = false

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
  document.cookie = `${EDITOR_COOKIE}=; max-age=0`
})

function server(): void {
  document.cookie = `${EDITOR_COOKIE}=tester`
  uploads = 0
  spyOn(globalThis, 'fetch').mockImplementation((async (request: string | URL | Request, init?: RequestInit) => {
    const path = String(request)

    if (path.includes('/can'))
      return Response.json({ denied: {}, prefix: '/admin' })

    if (path.includes('/rules'))
      return Response.json({ accept: 'image/*', images: 'image/*', maxSize: 1_000_000 })

    if (init?.method === 'POST' && path.includes('/files/')) {
      uploads++

      return refuse ? Response.json({ error: 'Not an image' }, { status: 415 }) : Response.json({ path: '/_kay/files/posts/new.png', width: 640, height: 480 })
    }

    if (init?.method === 'POST')
      return Response.json({})

    return Response.json({ collection: POSTS, entry: { slug: 'hello', data: { title: 'Hello', photo: '/old.png', photoWidth: 10, photoHeight: 10 }, version: 'v1', url: '/posts/hello' } })
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

async function open() {
  const image = document.createElement('img')
  const title = document.createElement('h1')

  image.dataset.page = ''
  image.setAttribute('data-kay-field-src', 'posts:hello:photo')
  title.dataset.page = ''
  title.setAttribute('data-kay-field', 'posts:hello:title')
  title.textContent = 'Hello'
  Object.assign(image, { getBoundingClientRect: () => ({ left: 10, top: 10, right: 310, bottom: 210, width: 300, height: 200 }) })
  document.body.append(image, title)
  mounted = await mountComponent(EDITOR, { entries: [HELLO], unclickable: [] })
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
