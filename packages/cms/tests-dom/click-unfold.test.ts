import type { Mounted } from 'kay/test'
import { join } from 'node:path'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const EDITOR = join(import.meta.dir, '../src/editor/editor.kay')
const ENTRY = { collection: 'pages', slug: 'home' }
let mounted: Mounted | undefined

// happy-dom has no caret lookup, which the editor's click handler asks.
Object.assign(document, { caretPositionFromPoint: () => null, elementsFromPoint: () => [] })

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  for (const element of document.querySelectorAll('[data-page]')) {
    element.remove()
  }
  mock.restore()
  localStorage.clear()
})

const block = (type: string, properties: Record<string, unknown>) => ({ type: 'object', properties: { type: { const: type }, ...properties }, required: ['type'] })
const SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      'type': 'array',
      'x-kay': { kind: 'blocks' },
      'items': {
        'anyOf': [
          block('hero', { heading: { type: 'string' } }),
          block('text', { body: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } } }),
        ],
        'x-kay': { kind: 'block' },
      },
    },
  },
}
const DATA = { sections: [{ type: 'hero', heading: 'Welcome' }, { type: 'text', body: 'Hello', items: [{ label: 'One' }, { label: 'Two' }] }] }

async function open() {
  spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ collection: { name: 'pages', title: 'Pages', schema: SCHEMA }, entry: { ...ENTRY, data: DATA, version: 'v1' } })) as unknown as typeof fetch)

  // The page the editor sits on, with the field a visitor clicks.
  const page = document.createElement('p')

  page.dataset.page = ''
  page.setAttribute('data-kay-field', 'pages:home:sections.1.items.1.label')
  // Styled text is not typed in place, which a plain one would be.
  page.innerHTML = 'T<em>wo</em>'
  document.body.append(page)
  mounted = await mountComponent(EDITOR, { entries: [ENTRY], unclickable: [] })
  await settle()
  await Bun.sleep(50)

  const root = mounted.root
  // The rows of a list, not those of the lists inside them.
  const rows = (list: Element) => [...list.querySelectorAll<HTMLElement>('[data-kcms-row]')].filter(row => row.parentElement?.closest('[data-kcms-row]') === list.closest('[data-kcms-row]'))
  const outer = () => rows(root.querySelector('[data-kcms-path="sections"]')!)[1]!
  const inner = () => rows(outer().querySelector('[data-kcms-path="sections.1.items"]')!)[1]!
  // The first fold button of a row is its own, the head coming before the body.
  const fold = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-kcms-fold]')!
  const expanded = (row: HTMLElement) => fold(row).getAttribute('aria-expanded')
  const press = async (target: HTMLElement) => {
    target.click()
    await settle()
  }

  return { page, root, outer, inner, fold, expanded, press }
}

test('a click on the page inside a folded block, in a nested list, unfolds both and puts the caret in the field', async () => {
  const { page, outer, inner, fold, expanded, press } = await open()

  await press(fold(inner()))
  await press(fold(outer()))
  expect([expanded(outer()), expanded(inner())]).toEqual(['false', 'false'])

  await press(page)
  await Bun.sleep(20)

  expect([expanded(outer()), expanded(inner())]).toEqual(['true', 'true'])
  expect(document.activeElement).toBe(inner().querySelector('input'))
})

test('once a click unfolded a block, editing the list or folding the block again does not unfold it or take the focus back', async () => {
  const { page, outer, fold, expanded, press } = await open()

  await press(fold(outer()))
  await press(page)
  await Bun.sleep(20)
  expect(expanded(outer())).toBe('true')

  const body = outer().querySelector<HTMLInputElement>('[data-kcms-path="sections.1.body"] input')!

  body.focus()
  body.value = 'Hello again'
  body.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  await Bun.sleep(20)
  expect(document.activeElement).toBe(body)

  await press(fold(outer()))
  await Bun.sleep(20)
  expect(expanded(outer())).toBe('false')
})
