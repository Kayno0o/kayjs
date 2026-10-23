import type { Mounted } from 'kay/test'
import { join } from 'node:path'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { forgetPlace, notePlace, placeCaret } from '../src/editor/caret'

const EDITOR = join(import.meta.dir, '../src/editor/editor.kay')
const POSTS = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], body: {}, schema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string', maxLength: 500 } } } }
const BODY = 'First **bold** paragraph.\n\nSecond [one](https://x.test) here.'
const SUMMARY = 'Line one\nline two is longer'
let mounted: Mounted | undefined
let caret: { node: Node, offset: number } | undefined

Object.assign(document, { caretPositionFromPoint: () => caret ? { offsetNode: caret.node, offset: caret.offset } : null, elementsFromPoint: () => [] })

afterEach(async () => {
  await Bun.sleep(20)
  mounted?.unmount()
  mounted = undefined
  caret = undefined
  for (const element of document.querySelectorAll('[data-page]'))
    element.remove()
  mock.restore()
  localStorage.clear()
})

async function open() {
  spyOn(globalThis, 'fetch').mockImplementation((async (request: string | URL | Request) => {
    const path = String(request)

    if (path.includes('/can'))
      return Response.json({ denied: {}, prefix: '/admin' })

    return Response.json({ collection: POSTS, entry: { slug: 'hello', data: { title: 'Hello', summary: SUMMARY }, body: BODY, version: 'v1', url: '/posts/hello' } })
  }) as unknown as typeof fetch)

  const page = document.createElement('main')

  page.dataset.page = ''
  page.innerHTML = '<div data-kay-body="posts:hello"><p>First <strong>bold</strong> paragraph.<img alt=""></p><p>Second <a href="#x">one</a> here.<img alt=""></p></div><p data-kay-field="posts:hello:summary">Line one line two is longer<img alt=""></p>'
  document.body.append(page)
  mounted = await mountComponent(EDITOR, { entries: [{ collection: 'posts', slug: 'hello' }], unclickable: [] })
  await settle()
  await Bun.sleep(50)

  return { root: mounted.root, page }
}

async function until(done: () => boolean) {
  const giveUp = Date.now() + 5000

  while (Date.now() < giveUp) {
    await settle()

    if (done())
      return
  }

  throw new Error('the page never reached the state the test waits for')
}

// A paragraph holding an image is not typed in place, so its click brings up the form.
test('a click in a paragraph of the body puts the caret at that place of the Markdown', async () => {
  const { root, page } = await open()
  const second = page.querySelectorAll('p')[1]!

  caret = { node: second.childNodes[2]!, offset: 3 }
  second.click()
  await until(() => document.activeElement instanceof HTMLTextAreaElement)

  const area = document.activeElement as HTMLTextAreaElement

  expect(root.contains(area)).toBe(true)
  expect(area.selectionStart).toBe(BODY.indexOf(' here.') + 3)
  expect(area.selectionEnd).toBe(area.selectionStart)
})

test('a click inside formatted text lands in the text, not in the markup', async () => {
  const { page } = await open()
  const bold = page.querySelector('strong')!

  caret = { node: bold.firstChild!, offset: 2 }
  bold.click()
  await until(() => document.activeElement instanceof HTMLTextAreaElement)

  expect((document.activeElement as HTMLTextAreaElement).selectionStart).toBe(BODY.indexOf('bold') + 2)
})

test('a click on a multi-line text of the page puts the caret in its textarea at that place', async () => {
  const { page } = await open()
  const summary = page.querySelector<HTMLElement>('[data-kay-field]')!

  caret = { node: summary.firstChild!, offset: 'Line one line t'.length }
  summary.click()
  await until(() => document.activeElement instanceof HTMLTextAreaElement)

  expect((document.activeElement as HTMLTextAreaElement).selectionStart).toBe(SUMMARY.indexOf('wo'))
})

test('a click the browser cannot place leaves the field focused as before', async () => {
  const { page } = await open()

  page.querySelectorAll('p')[1]!.click()
  await until(() => document.activeElement instanceof HTMLTextAreaElement)

  expect(document.activeElement).toBeInstanceOf(HTMLTextAreaElement)
})

test('a place noted for a click whose field the form does not show is dropped, not kept for a later reveal', async () => {
  const { page } = await open()
  const summary = page.querySelector<HTMLElement>('[data-kay-field]')!

  caret = { node: summary.firstChild!, offset: 3 }
  notePlace({ marker: { collection: 'posts', slug: 'hello', path: 'summary' }, element: summary }, 1, 1)
  forgetPlace()

  const area = document.createElement('textarea')

  area.value = SUMMARY
  placeCaret(area, { collection: 'posts', slug: 'hello' }, 'summary', false)
  expect(area.selectionStart).toBe(area.value.length)
})
