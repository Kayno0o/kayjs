import type { Mounted } from 'kay/test'
import { join } from 'node:path'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { EDITOR_COOKIE } from '../src/page-link'

const EDITOR = join(import.meta.dir, '../src/editor/editor.kay')
const POSTS = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], schema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } } } }
const MENU = { name: 'menu', title: 'Menu', single: true, kind: 'file', localized: false, components: [], schema: { type: 'object', properties: { label: { type: 'string' } } } }
const HELLO = { collection: 'posts', slug: 'hello' }
const NAV = { collection: 'menu', slug: 'index' }
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
  document.cookie = `${EDITOR_COOKIE}=; max-age=0`
})

// `slow` holds the answer of an entry's read back, so a test clicks while it loads.
// `fail` answers an entry's read with an error, `hang` never answers it.
function server(slow = 0, mode?: 'fail' | 'hang'): void {
  asked = []
  spyOn(globalThis, 'fetch').mockImplementation((async (request: string | URL | Request) => {
    const path = String(request)

    asked.push(path)

    if (path.includes('/can'))
      return Response.json({ denied: {}, prefix: '/admin' })

    if (mode === 'hang')
      await new Promise(() => {})

    await Bun.sleep(slow)

    if (mode === 'fail')
      return Response.json({ message: 'down' }, { status: 500 })

    return path.includes('/menu/')
      ? Response.json({ collection: MENU, entry: { slug: 'index', data: { label: 'Home' }, version: 'v1', url: '/' } })
      : Response.json({ collection: POSTS, entry: { slug: 'hello', data: { title: 'Hello world', summary: 'Short' }, version: 'v1', url: '/posts/hello' } })
  }) as unknown as typeof fetch)
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

const reads = () => asked.filter(path => path.includes('/entries/'))

async function open(entries: object[]) {
  const element = document.createElement('p')

  element.dataset.page = ''
  element.setAttribute('data-kay-field', 'posts:hello:summary')
  element.innerHTML = 'S<em>hort</em>'
  document.body.append(element)
  mounted = await mountComponent(EDITOR, { entries, unclickable: [] })
  await settle()
  await Bun.sleep(30)

  return { root: mounted.root, element }
}

test('a page that reads several entries shows each as a row and reads none of them', async () => {
  server()

  const { root } = await open([NAV, HELLO])

  expect([...root.querySelectorAll('.kcms-entry-idle > [data-part=head] [data-part=title]')].map(title => title.textContent)).toEqual(['menu', 'posts/hello'])
  expect([...root.querySelectorAll('.kcms-entry-idle button')].map(button => button.textContent?.trim())).toEqual(['Edit menu', 'Edit posts/hello'])
  expect(reads()).toEqual([])
})

test('the page\'s only entry loads at once', async () => {
  server()

  const { root } = await open([HELLO])

  await until(() => root.querySelector('.kcms-entry > [data-part=head] [data-part=title]')?.textContent === 'Hello world')
  expect(root.querySelector('.kcms-entry-idle')).toBeNull()
  expect(reads()).toHaveLength(1)
})

test('a row\'s button loads that entry alone, which then stays open', async () => {
  server()

  const { root } = await open([NAV, HELLO])

  root.querySelectorAll<HTMLButtonElement>('.kcms-entry-idle button')[1]!.click()
  await until(() => root.querySelector('.kcms-entry:not(.kcms-entry-idle) > [data-part=head] [data-part=title]')?.textContent === 'Hello world')

  expect(reads()).toHaveLength(1)
  expect(reads()[0]).toContain('/posts/hello')
  expect(root.querySelectorAll('.kcms-entry-idle')).toHaveLength(1)
})

test('a click on a field of the page loads its entry alone and brings the field up', async () => {
  server()

  const { root, element } = await open([NAV, HELLO])

  element.click()
  await until(() => document.activeElement?.closest('[data-kcms-path="summary"]') != null)

  expect(reads()).toHaveLength(1)
  expect(root.querySelectorAll('.kcms-entry-idle')).toHaveLength(1)
})

test('edits kept from an earlier visit open their entry, with the edits', async () => {
  server()
  document.cookie = `${EDITOR_COOKIE}=tester`
  localStorage.setItem('kcms:draft:tester:posts:hello', JSON.stringify({ entry: { collection: 'posts', slug: 'hello', data: { title: 'Kept title', summary: 'Short' } }, version: 'v1', at: Date.now() }))

  const { root } = await open([NAV, HELLO])

  await until(() => root.querySelector<HTMLInputElement>('[data-kcms-path="title"] input')?.value === 'Kept title')
  expect(reads()).toHaveLength(1)
  expect(root.querySelectorAll('.kcms-entry-idle')).toHaveLength(1)
})

test('the first click on a text of an entry still a row types in place once the entry has loaded', async () => {
  server()

  const { root } = await open([NAV, HELLO])
  const title = document.createElement('h1')

  title.dataset.page = ''
  title.setAttribute('data-kay-field', 'posts:hello:title')
  title.textContent = 'Hello world'
  document.body.append(title)
  title.click()
  await until(() => title.hasAttribute('contenteditable') || title.isContentEditable)

  expect(root.contains(document.activeElement)).toBe(false)
  expect(reads()).toHaveLength(1)
})

test('a second click on a text of an entry still loading types in place too, the side form not focused', async () => {
  server(150)

  const { root } = await open([NAV, HELLO])
  const title = document.createElement('h1')

  title.dataset.page = ''
  title.setAttribute('data-kay-field', 'posts:hello:title')
  title.textContent = 'Hello world'
  document.body.append(title)
  title.click()
  await Bun.sleep(30)
  title.click()
  await until(() => title.isContentEditable)

  expect(root.contains(document.activeElement)).toBe(false)
  expect(reads()).toHaveLength(1)
})

// A click above the visible top, which a field brought up in the form scrolls into view after.
function clickAbove(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: -50 }))
}

function addTitle(): HTMLElement {
  const title = document.createElement('h1')

  title.dataset.page = ''
  title.setAttribute('data-kay-field', 'posts:hello:title')
  title.textContent = 'Hello world'
  document.body.append(title)

  return title
}

test('a click on a text of an entry whose read failed brings up the side form at once, not after the wait', async () => {
  server(0, 'fail')

  const { root } = await open([NAV, HELLO])
  const title = addTitle()
  const measured = spyOn(title, 'getBoundingClientRect')

  clickAbove(title)
  await until(() => root.querySelector('.kcms-entry-failure') !== null)
  await Bun.sleep(400)

  expect(measured).toHaveBeenCalled()
  expect(title.isContentEditable).toBe(false)
})

test('a click on a text of an entry that never loads falls back to the form once the wait is over', async () => {
  server(0, 'hang')

  const { root } = await open([NAV, HELLO])
  const title = addTitle()

  const measured = spyOn(title, 'getBoundingClientRect')

  clickAbove(title)
  await Bun.sleep(4000)
  expect(measured).not.toHaveBeenCalled()
  await Bun.sleep(1800)

  expect(measured).toHaveBeenCalled()
  expect(title.isContentEditable).toBe(false)
  expect(root.querySelector('.kcms-entry-idle')).not.toBeNull()
}, 15000)

test('a click on a text of the page\'s only entry types in place once it has loaded', async () => {
  server(150)

  const { root } = await open([HELLO])
  const title = addTitle()

  title.click()
  await until(() => title.isContentEditable)

  expect(root.contains(document.activeElement)).toBe(false)
  expect(reads()).toHaveLength(1)
})

test('closing the editor ends the wait of a click, which then edits nothing', async () => {
  server(300)

  const { root } = await open([NAV, HELLO])
  const title = addTitle()

  const measured = spyOn(title, 'getBoundingClientRect')

  clickAbove(title)
  await Bun.sleep(30)
  root.querySelector<HTMLElement>('[aria-label="Hide the editor"]')!.click()
  await Bun.sleep(700)

  expect(measured).not.toHaveBeenCalled()
  expect(title.isContentEditable).toBe(false)
})
