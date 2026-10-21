import type { Mounted } from 'kay/test'
import { join } from 'node:path'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const EDITOR = join(import.meta.dir, '../src/editor/editor.kay')
let mounted: Mounted | undefined

// happy-dom has no caret lookup, which the editor's click handler asks.
Object.assign(document, { caretPositionFromPoint: () => null, elementsFromPoint: () => [] })

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  for (const element of document.querySelectorAll('[data-page]'))
    element.remove()

  mock.restore()
  localStorage.clear()
})

const block = (type: string, properties: Record<string, unknown>) => ({ type: 'object', properties: { type: { const: type }, ...properties }, required: ['type'] })
const SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    tagline: { 'type': 'string', 'x-kay-input': { when: 'caption' } },
    caption: { type: 'string' },
    long: { type: 'string', maxLength: 500 },
    tags: { type: 'array', items: { type: 'string' } },
    sections: {
      'type': 'array',
      'x-kay': { kind: 'blocks' },
      'items': {
        'anyOf': [block('hero', { heading: { type: 'string' } }), block('text', { body: { type: 'string' } })],
        'x-kay': { kind: 'block' },
      },
    },
  },
}
const DATA = { title: 'Home', subtitle: 'Sub', tags: ['one', 'two'], sections: [{ type: 'hero', heading: 'Welcome' }, { type: 'text', body: 'Hello' }] }

interface Page { marker: string, tag?: string, text?: string, attribute?: string, html?: string }

async function open(pages: Page[], entry: { collection: string, slug: string, locale?: string } = { collection: 'pages', slug: 'home' }, data: unknown = DATA) {
  spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ collection: { name: entry.collection, title: 'Pages', schema: SCHEMA }, entry: { ...entry, data, version: 'v1' } })) as unknown as typeof fetch)

  const elements = pages.map((page) => {
    const element = document.createElement(page.tag ?? 'p')

    element.dataset.page = ''

    if (page.attribute !== undefined)
      element.setAttribute(`data-kay-field-${page.attribute}`, page.marker)
    else
      element.setAttribute('data-kay-field', page.marker)

    if (page.html === undefined)
      element.textContent = page.text ?? ''
    else
      element.innerHTML = page.html

    document.body.append(element)

    return element
  })

  mounted = await mountComponent(EDITOR, { entries: [entry], unclickable: [] })
  await settle()
  await Bun.sleep(50)

  // The draft as the browser keeps it a moment after the last keystroke, which the editor's own drafts write.
  const draft = async (path: string) => {
    await Bun.sleep(220)

    const kept = JSON.parse(localStorage.getItem(`kcms:draft:${entry.collection}:${entry.slug}${entry.locale === undefined ? '' : `@${entry.locale}`}`) ?? 'null') as { entry: { data: unknown } } | null

    return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], kept?.entry.data)
  }
  const root = mounted.root
  const type = async (element: HTMLElement, text: string) => {
    element.textContent = text
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  const click = async (element: HTMLElement) => {
    element.click()
    await settle()
    await Bun.sleep(20)
  }

  return { elements, root, draft, type, click }
}

test('a click on a text unlocks it for typing and the draft follows each keystroke, the form field included', async () => {
  const { elements: [title], root, draft, type, click } = await open([{ marker: 'pages:home:title', text: 'Home' }])

  await click(title!)

  expect(title!.getAttribute('contenteditable')).toBe('plaintext-only')
  expect(document.activeElement).toBe(title!)

  await type(title!, 'Welcome home')

  expect(await draft('title')).toBe('Welcome home')
  expect(root.querySelector<HTMLInputElement>('[data-kcms-path="title"] input')!.value).toBe('Welcome home')
})

test('a click in the text already being typed in acts on nothing, and leaving it locks it again', async () => {
  const { elements: [title], click } = await open([{ marker: 'pages:home:title', text: 'Home' }])

  await click(title!)

  const event = new MouseEvent('click', { bubbles: true, cancelable: true })

  title!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)

  expect(title!.getAttribute('role')).toBe('textbox')
  expect(title!.getAttribute('aria-label')).toBe('Title')

  title!.blur()
  expect(title!.hasAttribute('contenteditable')).toBe(false)
  expect(title!.hasAttribute('role')).toBe(false)
})

test('a text inside a block, and an item of a list of texts, are typed in place', async () => {
  const { elements: [heading, tag], draft, type, click } = await open([{ marker: 'pages:home:sections.0.heading', tag: 'h2', text: 'Welcome' }, { marker: 'pages:home:tags.1', text: 'two' }])

  await click(heading!)
  await type(heading!, 'Hi')
  await click(tag!)
  await type(tag!, 'deux')

  expect(await draft('sections.0.heading')).toBe('Hi')
  expect(await draft('tags.1')).toBe('deux')
  expect(await draft('tags.0')).toBe('one')
  // Taking the second text ends the first one's edit.
  expect(heading!.hasAttribute('contenteditable')).toBe(false)
})

test('a localized entry keeps the edit to its own locale', async () => {
  const entry = { collection: 'pages', slug: 'home', locale: 'fr' }
  const { elements: [title], draft, type, click } = await open([{ marker: 'pages:home@fr:title', text: 'Accueil' }], entry, { ...DATA, title: 'Accueil' })

  await click(title!)
  await type(title!, 'Bienvenue')

  expect(await draft('title')).toBe('Bienvenue')
})

test('emptying an optional text unsets it, a required one stays empty', async () => {
  const { elements: [title, subtitle], draft, type, click } = await open([{ marker: 'pages:home:title', text: 'Home' }, { marker: 'pages:home:subtitle', text: 'Sub' }])

  await click(subtitle!)
  await type(subtitle!, '')
  // The unset waits for the end of the edit, as the page drops an element with no text.
  expect(await draft('subtitle')).toBeUndefined()
  await click(title!)
  await type(title!, '')

  expect(await draft('subtitle')).toBeUndefined()
  expect(await draft('title')).toBe('')
})

test('a field the form hides until its sibling is filled is still typed in on the page', async () => {
  const { elements: [tagline], draft, type, click } = await open([{ marker: 'pages:home:tagline', text: 'Shown by the page' }])

  await click(tagline!)
  await type(tagline!, 'Typed')
  expect(await draft('tagline')).toBe('Typed')
})

test('HTML typed or pasted stays text, and line breaks do not stay', async () => {
  const { elements: [title], draft, type, click } = await open([{ marker: 'pages:home:title', text: 'Home' }])

  await click(title!)
  await type(title!, '<img src=x onerror="alert(1)"> & <b>bold</b>')

  expect(await draft('title')).toBe('<img src=x onerror="alert(1)"> & <b>bold</b>')
  expect(title!.children).toHaveLength(0)

  await type(title!, 'one\ntwo three')

  expect(await draft('title')).toBe('one two three')
})

test('Enter and Escape leave the text instead of breaking the line', async () => {
  const { elements: [title], click } = await open([{ marker: 'pages:home:title', text: 'Home' }])

  await click(title!)

  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })

  title!.dispatchEvent(enter)

  expect(enter.defaultPrevented).toBe(true)
  expect(title!.hasAttribute('contenteditable')).toBe(false)
})

test('a button or a link is not made a text box by a click', async () => {
  const { elements: [button], click } = await open([{ marker: 'pages:home:title', tag: 'button', text: 'Go' }])

  await click(button!)

  expect(button!.hasAttribute('contenteditable')).toBe(false)
})

test('what is not a one-line text on its own element falls back to the form', async () => {
  const { elements: [long, attribute, mixed], root, click } = await open([
    { marker: 'pages:home:long', text: 'A long text' },
    { marker: 'pages:home:title', tag: 'img', attribute: 'alt' },
    { marker: 'pages:home:subtitle', html: 'Sub <em>styled</em>' },
  ])

  for (const element of [long!, attribute!, mixed!]) {
    await click(element)

    expect(element.hasAttribute('contenteditable')).toBe(false)
  }

  expect(document.activeElement).toBe(root.querySelector('[data-kcms-path="subtitle"] input'))
})

test('a text clicked before its entry has loaded is left to the form', async () => {
  spyOn(globalThis, 'fetch').mockImplementation((async () => new Promise(() => undefined)) as unknown as typeof fetch)

  const page = document.createElement('p')

  page.dataset.page = ''
  page.setAttribute('data-kay-field', 'pages:home:title')
  page.textContent = 'Home'
  document.body.append(page)
  mounted = await mountComponent(EDITOR, { entries: [{ collection: 'pages', slug: 'home' }], unclickable: [] })
  await settle()
  page.click()
  await settle()

  expect(page.hasAttribute('contenteditable')).toBe(false)
})
