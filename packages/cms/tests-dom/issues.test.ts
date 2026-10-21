import type { Mounted } from 'kay/test'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const NOTES: ScreenCollection = {
  name: 'notes',
  kind: 'folder',
  localized: false,
  components: [],
  schema: {
    type: 'object',
    required: ['title', 'count'],
    properties: {
      title: { type: 'string', minLength: 3, maxLength: 8, pattern: '^[a-z ]+$' },
      count: { type: 'integer', minimum: 1, maximum: 9 },
      summary: { type: 'string', maxLength: 200 },
      meta: { 'type': 'object', 'x-kay': { kind: 'json' } },
    },
  },
}
const sent = (fetched: ReturnType<typeof server>) => JSON.parse(String((fetched.mock.calls[0]![1] as RequestInit).body)) as { data: Record<string, unknown> }
const entry = (data: Record<string, unknown>) => ({ slug: 'first', locale: undefined, data, draft: false, version: 'v1', url: '/notes/first' }) as unknown as StoredEntry
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
})

// The server's answer to a save: refused with these issues, or saved.
function server(issues: { path: string, message: string, key?: string }[] | undefined) {
  return spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json(issues ? { issues } : { saved: true, version: 'v2' })) as unknown as typeof fetch)
}

async function open(data: Record<string, unknown> = { title: 'hello', count: 3 }, stored: StoredEntry | null = entry(data)) {
  mounted = await mountComponent('src/components/entry-screen.kay', { collection: NOTES, entry: stored ?? undefined })
  await settle()

  const root = mounted.root
  const box = (name: string) => root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-kcms-path="${name}"] :is(input, textarea)`)!
  const type = async (name: string, text: string) => {
    const control = box(name)

    control.value = text
    control.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  const leave = async (name: string) => {
    box(name).dispatchEvent(new FocusEvent('blur'))
    box(name).dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  }
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    for (let wait = 0; wait < 30; wait++) {
      await Bun.sleep(10)
      await settle()
    }
  }
  const issueOf = (name: string) => root.querySelector(`[data-kcms-path="${name}"] .kui-form-field-issue`)?.textContent?.trim()

  return { root, box, type, leave, submit, issueOf }
}

test('the limits of a schema are attributes of its controls', async () => {
  const { box } = await open()

  expect(box('title').getAttribute('minlength')).toBe('3')
  expect(box('title').getAttribute('maxlength')).toBe('8')
  expect(box('title').getAttribute('pattern')).toBe('^[a-z ]+$')
  expect(box('title').hasAttribute('required')).toBe(true)
  expect(box('count').getAttribute('min')).toBe('1')
  expect(box('count').getAttribute('max')).toBe('9')
  expect(box('count').hasAttribute('required')).toBe(true)
  expect(box('summary').hasAttribute('required')).toBe(false)
})

test('a field breaking its limits says so once left, then follows what is typed, and a field not left says nothing', async () => {
  const { type, leave, issueOf } = await open()

  await type('title', 'a')
  expect(issueOf('title')).toBeUndefined()
  await leave('title')
  expect(issueOf('title')).toBe('Title needs at least 3 characters')
  await type('title', 'abcd')
  expect(issueOf('title')).toBeUndefined()
  await type('title', 'ABCD')
  expect(issueOf('title')).toBe('Title is not in the expected form')
  expect(issueOf('count')).toBeUndefined()
  await type('count', '12')
  await leave('count')
  expect(issueOf('count')).toBe('Count must be at most 9')
  await type('count', '')
  expect(issueOf('count')).toBe('Count is required')
})

test('a refused save marks every refused field, lists them in a summary of links and puts the focus on the first', async () => {
  const { root, submit, type, issueOf } = await open()

  await type('title', 'x')
  server([{ path: 'title', message: 'Title needs at least 3 characters' }, { path: 'count', message: 'Count is required' }])
  await submit()

  expect(issueOf('title')).toBe('Title needs at least 3 characters')
  expect(issueOf('count')).toBe('Count is required')

  const links = [...root.querySelectorAll<HTMLAnchorElement>('.kcms-summary a')]

  expect(links.map(link => link.textContent)).toEqual(['Title needs at least 3 characters', 'Count is required'])
  expect(root.querySelector('.kcms-summary')?.textContent).toContain('2 fields need fixing')
  expect(document.activeElement).toBe(root.querySelector('[data-kcms-path="title"] input'))

  links[1]!.click()
  await settle()

  expect(document.activeElement).toBe(root.querySelector('[data-kcms-path="count"] input'))
  expect(links[1]!.getAttribute('href')).toBe(`#${root.querySelector('[data-kcms-path="count"]')!.id}`)
})

test('an edit answers its own field\'s issue only, in the field and in the summary', async () => {
  const { root, submit, type, issueOf } = await open()

  await type('summary', 'x')
  server([{ path: 'title', message: 'Title is not valid' }, { path: 'count', message: 'Count is not valid' }, { path: 'summary', message: 'Summary is not valid' }])
  await submit()
  await type('count', '4')

  expect(issueOf('count')).toBeUndefined()
  expect(issueOf('title')).toBe('Title is not valid')
  expect(issueOf('summary')).toBe('Summary is not valid')
  expect([...root.querySelectorAll('.kcms-summary a')].map(link => link.textContent)).toEqual(['Title is not valid', 'Summary is not valid'])
})

test('a JSON box that does not parse stops the save, says so by name and follows what is typed', async () => {
  const { box, type, leave, submit, issueOf, root } = await open({ title: 'hello', count: 3, meta: { a: 1 } })
  const fetched = server(undefined)

  await type('meta', '{ "a": ')
  await leave('meta')
  expect(issueOf('meta')).toBe('Meta is not valid JSON')
  await submit()

  expect(fetched).not.toHaveBeenCalled()
  expect(root.querySelector('.kcms-summary')?.textContent).toContain('Meta is not valid JSON')
  expect(document.activeElement).toBe(box('meta'))

  await type('meta', '{ "a": 2 }')
  expect(issueOf('meta')).toBeUndefined()
  await submit()

  expect(fetched).toHaveBeenCalledTimes(1)
  expect(sent(fetched).data.meta).toEqual({ a: 2 })
})

test('a JSON box typed in and saved at once, with no blur, saves what it holds', async () => {
  const { type, submit } = await open({ title: 'hello', count: 3, meta: { a: 1 } })
  const fetched = server(undefined)

  await type('meta', '{ "b": 1 }')
  await submit()

  expect(sent(fetched).data.meta).toEqual({ b: 1 })
})

test('a slug taken marks the slug field, which the summary links to, and typing a new slug answers it', async () => {
  const { root, submit, type, issueOf } = await open({}, null)

  await type('title', 'hello')
  const first = root.querySelector<HTMLInputElement>('.kcms-field[id$="-s"] input')!

  first.value = 'first'
  first.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  server([{ path: '', key: 'slug', message: 'An entry with this slug already exists: pick another slug' }])
  await submit()

  const slug = root.querySelector<HTMLInputElement>('.kcms-field[id$="-s"] input')!

  expect(root.querySelector('.kcms-field[id$="-s"] .kui-form-field-issue')?.textContent).toContain('already exists')
  expect(slug.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(slug)
  expect(root.querySelector('.kcms-summary a')?.getAttribute('href')).toBe(`#${slug.closest('.kcms-field')!.id}`)
  expect(issueOf('title')).toBeUndefined()

  slug.value = 'second'
  slug.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()

  expect(root.querySelector('.kcms-field[id$="-s"] .kui-form-field-issue')).toBeNull()
  expect(root.querySelector('.kcms-summary')).toBeNull()
})
