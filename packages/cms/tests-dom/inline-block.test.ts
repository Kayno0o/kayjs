import type { Mounted } from 'kay/test'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Editor from '../src/editor/editor.kay'
import { EDITOR_COOKIE } from '../src/page-link'

let mounted: Mounted | undefined

Object.assign(document, { caretPositionFromPoint: () => null, elementsFromPoint: () => [] })

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  for (const element of document.querySelectorAll('[data-page]'))
    element.remove()

  mock.restore()
  localStorage.clear()
  document.cookie = `${EDITOR_COOKIE}=; max-age=0`
})

const SCHEMA = { type: 'object', properties: { title: { type: 'string' }, long: { type: 'string', maxLength: 500 }, intro: { 'type': 'string', 'x-kay': { kind: 'markdown' } } } }
const BODY = 'First **bold** paragraph.\n\nSecond [one](https://x.test) here.\n\n# A heading\n\n- item a\n- item b\n\nSame.\n\nSame.\n\nIt\'s "quoted"'
const HTML = '<p>First <strong>bold</strong> paragraph.</p><p>Second <a href="https://x.test">one</a> here.</p><h1>A heading</h1><ul><li>item a</li><li>item b</li></ul><p>Same.</p><p>Same.</p><p>It’s “quoted”</p><p><img src="a.png" alt="">Image</p>'
const DATA = { title: 'Home', long: 'one\ntwo', intro: 'Intro **text**' }

async function open(fields = '', data: Record<string, unknown> = DATA) {
  document.cookie = `${EDITOR_COOKIE}=tester`
  spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ collection: { name: 'pages', title: 'Pages', schema: SCHEMA, body: {} }, entry: { collection: 'pages', slug: 'home', data, body: BODY, version: 'v1' } })) as unknown as typeof fetch)

  const page = document.createElement('main')

  page.dataset.page = ''
  page.innerHTML = `<div data-kay-body="pages:home">${HTML}</div>${fields}`
  document.body.append(page)

  mounted = await mountComponent(Editor, { entries: [{ collection: 'pages', slug: 'home' }], unclickable: [] })
  await settle()
  await Bun.sleep(50)

  const click = async (element: Element) => {
    (element as HTMLElement).click()
    await settle()
    await Bun.sleep(20)
  }
  const type = async (element: HTMLElement, text: string) => {
    element.textContent = text
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  const draft = async () => {
    await Bun.sleep(220)

    return (JSON.parse(localStorage.getItem('kcms:draft:tester:pages:home') ?? 'null') as { entry: { body: string, data: Record<string, unknown> } } | null)?.entry
  }
  const blocks = [...page.querySelectorAll<HTMLElement>('[data-kay-body] > *')]

  return { page, root: mounted.root, blocks, click, type, draft }
}

function key(element: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

  element.dispatchEvent(event)

  return event
}

test('a paragraph of the body is typed as its Markdown source, and only its lines change in the draft', async () => {
  const { blocks: [, second], click, type, draft } = await open()

  await click(second!)

  expect(second!.getAttribute('contenteditable')).toBe('plaintext-only')
  expect(second!.hasAttribute('data-kay-multiline')).toBe(true)
  expect(second!.textContent).toBe('Second [one](https://x.test) here.')
  expect(second!.getAttribute('aria-label')).toBe('Body')

  await type(second!, 'Second [one](https://x.test) here, and more.')
  expect((await draft())?.body).toBe(BODY.replace('here.', 'here, and more.'))

  // The block is kept in the draft as far as it goes: a longer one moves the end, not the lines after it.
  await type(second!, 'Second.')
  expect((await draft())?.body).toBe(BODY.replace('Second [one](https://x.test) here.', 'Second.'))
})

test('a heading and a list item are typed with their marker', async () => {
  const { blocks: [, , heading, list], click } = await open()

  await click(heading!)
  expect(heading!.textContent).toBe('# A heading')
  heading!.dispatchEvent(new FocusEvent('blur'))

  const item = list!.querySelectorAll('li')[1]!

  await click(item)
  expect(item.textContent).toBe('- item b')
})

test('the second of two identical paragraphs edits its own lines', async () => {
  const { blocks, click, type, draft } = await open()
  const second = blocks[5]!

  expect(second.textContent).toBe('Same.')
  await click(second)
  await type(second, 'Other.')
  expect((await draft())?.body).toBe(BODY.replace('Same.\n\nSame.', 'Same.\n\nOther.'))
})

test('Enter in a block is a line break, Ctrl+Enter keeps the text and Escape puts the page back', async () => {
  const { blocks: [first], click, type, draft } = await open()
  const html = first!.innerHTML

  await click(first!)

  const enter = key(first!, { key: 'Enter' })

  expect(enter.defaultPrevented).toBe(false)
  expect(first!.getAttribute('contenteditable')).toBe('plaintext-only')

  await type(first!, 'First\nline two')
  expect((await draft())?.body.startsWith('First\nline two\n\nSecond')).toBe(true)

  const escape = key(first!, { key: 'Escape' })

  expect(escape.defaultPrevented).toBe(true)
  expect(first!.hasAttribute('contenteditable')).toBe(false)
  expect(first!.innerHTML).toBe(html)
  expect((await draft())).toBeUndefined()

  await click(first!)
  key(first!, { key: 'Enter', ctrlKey: true })
  expect(first!.hasAttribute('contenteditable')).toBe(false)
})

test('leaving a block that was not changed shows it rendered as before', async () => {
  const { blocks: [first], click } = await open()
  const html = first!.innerHTML

  await click(first!)
  expect(first!.textContent).toBe('First **bold** paragraph.')
  first!.dispatchEvent(new FocusEvent('blur'))
  expect(first!.innerHTML).toBe(html)
})

test('HTML typed in a block stays text', async () => {
  const { blocks: [first], click, type, draft } = await open()

  await click(first!)
  await type(first!, '<img src=x onerror="alert(1)"> **hi**')

  expect(first!.children).toHaveLength(0)
  expect((await draft())?.body.startsWith('<img src=x onerror="alert(1)"> **hi**\n\nSecond')).toBe(true)
})

test('a block whose text the Markdown does not hold, or that holds an image, is left to the form', async () => {
  const { blocks, root, click } = await open()
  const [quoted, image] = [blocks[6]!, blocks[7]!]

  await click(quoted)
  expect(quoted.hasAttribute('contenteditable')).toBe(false)
  expect(document.activeElement?.tagName).toBe('TEXTAREA')
  expect(root.contains(document.activeElement)).toBe(true)

  await click(image)
  expect(image.hasAttribute('contenteditable')).toBe(false)
})

test('a long text is typed in place with its line breaks, Enter taking a new line', async () => {
  const { page, click, type, draft } = await open('<p data-kay-field="pages:home:long">one two</p>')
  const long = page.querySelector<HTMLElement>('[data-kay-field]')!

  await click(long)

  expect(long.getAttribute('contenteditable')).toBe('plaintext-only')
  expect(long.textContent).toBe('one\ntwo')
  expect(key(long, { key: 'Enter' }).defaultPrevented).toBe(false)

  await type(long, 'one\ntwo\r\nthree')
  expect((await draft())?.data.long).toBe('one\ntwo\nthree')

  key(long, { key: 'Enter', metaKey: true })
  expect(long.hasAttribute('contenteditable')).toBe(false)
})

test('a long text the page shows otherwise than the value is left to the form', async () => {
  const { page, click } = await open('<p data-kay-field="pages:home:long">Something else</p>')
  const long = page.querySelector<HTMLElement>('[data-kay-field]')!

  await click(long)

  expect(long.hasAttribute('contenteditable')).toBe(false)
})

test('a Markdown field of the entry is typed block by block like the body', async () => {
  const { page, click, type, draft } = await open('<div data-kay-field="pages:home:intro"><p>Intro <strong>text</strong></p></div>')
  const paragraph = page.querySelector<HTMLElement>('[data-kay-field] p')!

  await click(paragraph)
  expect(paragraph.textContent).toBe('Intro **text**')
  expect(paragraph.getAttribute('aria-label')).toBe('Intro')

  await type(paragraph, 'Intro **text** more')
  expect((await draft())?.data.intro).toBe('Intro **text** more')
})

// The page renders the block again as another tag once its marker changes, which the test does by hand as happy-dom runs no page.
function swapTag(block: HTMLElement, tag: string, html: string): HTMLElement {
  const next = document.createElement(tag)

  next.innerHTML = html
  block.replaceWith(next)

  return next
}

async function typeAt(element: HTMLElement, text: string, caret: number): Promise<void> {
  element.textContent = text
  document.getSelection()?.collapse(element.firstChild, caret)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await Bun.sleep(0)
}

test('typing a heading marker at the start of a paragraph goes on in the heading it becomes, the caret kept', async () => {
  const { blocks: [, second], click, draft } = await open()

  await click(second!)
  await typeAt(second!, '# Second [one](https://x.test) here.', 2)

  const heading = swapTag(second!, 'h1', 'Second <a href="https://x.test">one</a> here.')

  await Bun.sleep(30)

  expect(heading.getAttribute('contenteditable')).toBe('plaintext-only')
  expect(heading.textContent).toBe('# Second [one](https://x.test) here.')
  expect(document.activeElement).toBe(heading)
  expect(document.getSelection()?.anchorOffset).toBe(2)
  expect((await draft())?.body).toBe(BODY.replace('Second [one](https://x.test) here.', '# Second [one](https://x.test) here.'))
})

test('deleting the marker of a heading goes on in the paragraph it becomes', async () => {
  const { blocks: [, , heading], click } = await open()

  await click(heading!)
  await typeAt(heading!, 'A heading', 0)

  const paragraph = swapTag(heading!, 'p', 'A heading')

  await Bun.sleep(30)

  expect(paragraph.getAttribute('contenteditable')).toBe('plaintext-only')
  expect(document.activeElement).toBe(paragraph)
  expect(document.getSelection()?.anchorOffset).toBe(0)
})

test('Escape after a tag change puts the paragraph back as it was before the first keystroke', async () => {
  const { blocks: [, second], click, draft } = await open()

  await click(second!)
  await typeAt(second!, '# Second [one](https://x.test) here.', 2)

  const heading = swapTag(second!, 'h1', 'Second <a href="https://x.test">one</a> here.')

  await Bun.sleep(30)
  expect(heading.getAttribute('contenteditable')).toBe('plaintext-only')
  key(heading, { key: 'Escape' })
  expect(heading.hasAttribute('contenteditable')).toBe(false)
  expect(await draft()).toBeUndefined()
})
