import type { Mounted } from 'kay/test'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Editor from '../src/editor/editor.kay'
import { EDITOR_COOKIE } from '../src/page-link'
import { until } from '../tests/until'

const POSTS = { name: 'posts', title: 'Posts', kind: 'folder', localized: false, components: [], schema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } } } }
const MENU = { name: 'menu', title: 'Menu', single: true, kind: 'file', localized: false, components: [], schema: { type: 'object', properties: { label: { type: 'string' } } } }
const HELLO = { collection: 'posts', slug: 'hello' }
const NAV = { collection: 'menu', slug: 'index' }
let mounted: Mounted | undefined
let asked: string[] = []
// How many reads of an entry were answered, for a test that waits for the answer to land.
let answered = 0

Object.assign(document, { caretPositionFromPoint: () => null, elementsFromPoint: () => [] })

afterEach(async () => {
  await settle()
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
  answered = 0
  spyOn(globalThis, 'fetch').mockImplementation((async (request: string | URL | Request) => {
    const path = String(request)

    asked.push(path)

    if (path.includes('/can'))
      return Response.json({ denied: {}, prefix: '/admin' })

    if (mode === 'hang')
      await new Promise(() => undefined)

    await Bun.sleep(slow)
    answered++

    if (mode === 'fail')
      return Response.json({ message: 'down' }, { status: 500 })

    return path.includes('/menu/')
      ? Response.json({ collection: MENU, entry: { slug: 'index', data: { label: 'Home' }, version: 'v1', url: '/' } })
      : Response.json({ collection: POSTS, entry: { slug: 'hello', data: { title: 'Hello world', summary: 'Short' }, version: 'v1', url: '/posts/hello' } })
  }) as unknown as typeof fetch)
}

const reads = () => asked.filter(path => path.includes('/entries/'))

async function open(entries: object[], settleEvery?: number) {
  const element = document.createElement('p')

  element.dataset.page = ''
  element.setAttribute('data-kay-field', 'posts:hello:summary')
  element.innerHTML = 'S<em>hort</em>'
  document.body.append(element)
  mounted = await mountComponent(Editor, { entries, unclickable: [], settleEvery })
  await settle()
  await until(() => mounted!.root.querySelector('.kcms-entry, .kcms-entry-idle') !== null)

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
  await until(() => reads().length === 1)
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
  // Bounded below the wait for an entry's read (about five seconds), as the form comes up at once and not when that wait ends.
  await until(() => measured.mock.calls.length > 0, 3000)

  expect(measured).toHaveBeenCalled()
  expect(title.isContentEditable).toBe(false)
})

test('a click on a text of an entry that never loads falls back to the form once the wait is over', async () => {
  server(0, 'hang')

  const { root } = await open([NAV, HELLO], 10)
  const title = addTitle()

  const measured = spyOn(title, 'getBoundingClientRect')

  clickAbove(title)
  await settle()
  expect(measured).not.toHaveBeenCalled()
  await until(() => measured.mock.calls.length > 0)

  expect(measured).toHaveBeenCalled()
  expect(title.isContentEditable).toBe(false)
  expect(root.querySelector('.kcms-entry-idle')).not.toBeNull()
})

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
  await until(() => reads().length === 1)
  root.querySelector<HTMLElement>('[aria-label="Hide the editor"]')!.click()
  await until(() => answered === 1)
  // A deliberate wait for nothing to happen: the click would measure the title within it once its entry had loaded.
  await Bun.sleep(300)

  expect(measured).not.toHaveBeenCalled()
  expect(title.isContentEditable).toBe(false)
})
