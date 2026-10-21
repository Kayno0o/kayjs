import type { Mounted } from 'kay/test'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const PEOPLE: ScreenCollection = {
  name: 'people',
  kind: 'folder',
  localized: false,
  components: [],
  description: 'Who edits the site',
  schema: {
    type: 'object',
    required: ['note'],
    properties: {
      bio: { 'type': 'string', 'maxLength': 50, 'x-kay': { kind: 'textarea' } },
      story: { 'type': 'string', 'x-kay-input': { rows: 6 } },
      tinted: { type: 'boolean' },
      shade: { 'type': 'string', 'x-kay-input': { when: 'tinted' } },
      featured: { type: 'boolean' },
      stock: { type: 'integer' },
      tags: { 'type': 'array', 'items': { type: 'string' }, 'x-kay-input': { lines: true } },
      note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      parts: { type: 'array', items: { type: 'object', properties: { on: { type: 'boolean' }, tone: { 'type': 'string', 'x-kay-input': { when: 'on' } } } } },
    },
  },
}
const entry = (data: Record<string, unknown>) => ({ slug: 'jo', locale: undefined, data, draft: false, version: 'v1', url: '/people/jo' }) as unknown as StoredEntry
const sent = (fetched: ReturnType<typeof server>) => JSON.parse(String((fetched.mock.calls[0]![1] as RequestInit).body)) as { data: Record<string, unknown> }
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
})

function server(issues?: { path: string, message: string }[]) {
  return spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json(issues ? { issues } : { saved: true, version: 'v2' })) as unknown as typeof fetch)
}

async function open(data: Record<string, unknown> = { note: 'x' }) {
  mounted = await mountComponent('src/components/entry-screen.kay', { collection: PEOPLE, entry: entry(data) })
  await settle()

  const root = mounted.root
  const field = (path: string) => root.querySelector<HTMLElement>(`[data-kcms-path="${path}"]`)!
  const box = (path: string) => field(path).querySelector<HTMLInputElement & HTMLTextAreaElement>('input:not([type="checkbox"]), textarea')!
  const type = async (path: string, text: string) => {
    box(path).value = text
    box(path).dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    for (let wait = 0; wait < 30; wait++) {
      await Bun.sleep(10)
      await settle()
    }
  }

  return { root, field, box, type, submit }
}

test('a collection\'s description sits under its entry\'s name', async () => {
  const { root } = await open()

  expect(root.querySelector('.kcms-entry-header')?.textContent).toContain('Who edits the site')
})

test('a text with a maximum counts its length, and the count follows what is typed', async () => {
  const { field, type } = await open({ note: 'x', bio: 'abc' })

  expect(field('bio').textContent).toContain('3 / 50')
  await type('bio', 'abcdef')
  expect(field('bio').textContent).toContain('6 / 50')
})

test('a field with a `when` at the top level shows once its sibling holds a value, and so does one in a list item', async () => {
  const { field, root } = await open({ note: 'x', parts: [{ on: false }] })

  expect(field('shade').hidden).toBe(true)

  field('tinted').querySelector<HTMLInputElement>('input')!.click()
  await settle()
  expect(field('shade').hidden).toBe(false)
  expect(field('parts.0.tone').hidden).toBe(true)

  root.querySelector<HTMLInputElement>('[data-kcms-path="parts.0.on"] input')!.click()
  await settle()
  expect(field('parts.0.tone').hidden).toBe(false)
})

test('a field the schema refused shows although its `when` sibling is empty, so the refusal can be fixed', async () => {
  const { field, submit, type } = await open({ note: 'x', shade: 'dark' })

  await type('story', 'a')
  expect(field('shade').hidden).toBe(true)
  server([{ path: 'shade', message: 'Shade is not valid' }])
  await submit()

  expect(field('shade').hidden).toBe(false)
  expect(field('shade').querySelector('.kui-form-field-issue')?.textContent).toBe('Shade is not valid')

  await type('shade', 'light')
  expect(field('shade').hidden).toBe(false)
})

test('an integer refuses the keys of a decimal or an exponent, and a pasted decimal shows the figure kept at once', async () => {
  const { box, type } = await open({ note: 'x', stock: 4 })

  for (const key of [',', 'e', 'E', '.', '+']) {
    const press = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })

    box('stock').dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
  }

  await type('stock', '4.7')
  expect(box('stock').value).toBe('4')
  await type('stock', '5.9')
  expect(box('stock').value).toBe('5')
})

test('a toggle shows the issue a refused save left on it', async () => {
  const { field, type, submit } = await open()

  await type('story', 'a')
  server([{ path: 'featured', message: 'Featured is not valid' }])
  await submit()

  expect(field('featured').querySelector('.kui-form-field-issue')?.textContent).toBe('Featured is not valid')
  expect(field('featured').querySelector('input')!.getAttribute('aria-invalid')).toBe('true')
})

test('a list of lines emptied on an optional field is unset, not stored as an empty list', async () => {
  const { type, submit } = await open({ note: 'x', tags: ['a', 'b'] })
  const fetched = server()

  await type('tags', '')
  await submit()

  expect(sent(fetched).data).not.toHaveProperty('tags')
})

test('a nullable field listed as required stores null when cleared, the key left out being refused', async () => {
  const { type, submit } = await open({ note: 'x' })
  const fetched = server()

  await type('note', '')
  await submit()

  expect(sent(fetched).data.note).toBeNull()
})

test('a text given rows keeps its minimum through the element\'s style property, not a style attribute a strict policy drops', async () => {
  const { box } = await open()

  expect(box('story').style.getPropertyValue('--kcms-rows')).toBe('6')
  expect(box('story').hasAttribute('data-kcms-grow')).toBe(true)
})
