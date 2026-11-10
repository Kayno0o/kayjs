import type { Mounted } from 'kay/test'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
import type { TrashScreen } from '../src/screens'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { until } from '../tests/until'
import WithToaster from './with-toaster.kay'

const NOTES: ScreenCollection = {
  name: 'notes',
  kind: 'loaded',
  localized: false,
  components: [],
  schema: { type: 'object', properties: { title: { type: 'string' } } },
}
const rows: TrashScreen['rows'] = [
  { id: '200', deletedAt: new Date(200), author: 'Ada', slug: 'second', title: 'Two' },
  { id: '100', deletedAt: new Date(100), slug: 'first', locale: 'fr', title: 'One' },
]
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
})

async function open(shown: TrashScreen['rows']): Promise<ParentNode> {
  mounted = await mountComponent(WithToaster, { trash: { collection: NOTES, rows: shown } })
  await settle()

  return mounted.root
}

// A deliberate wait for nothing to happen: the request a test expects not to come would have been sent by now.
async function quiet(): Promise<void> {
  for (let wait = 0; wait < 10; wait++) {
    await Bun.sleep(5)
    await settle()
  }
}

const labelled = (label: string) => [...document.querySelectorAll('button')].filter(item => item.textContent?.trim() === label)
// Each row has its trigger then, rendered after it, the dialog's own button.
const confirmFirst = () => labelled('Restore')[1]!.click()

test('an empty trash says so, and a trash lists each entry with its slug and locale', async () => {
  const empty = await open([])

  expect(empty.textContent).toContain('The trash is empty')
  mounted?.unmount()

  const root = await open(rows)

  expect(root.querySelectorAll('.kcms-revision')).toHaveLength(2)
  expect(root.textContent).toContain('Two')
  expect(root.textContent).toContain('first (fr)')
})

test('Restore asks first, then posts the entry\'s id to the trash API and says so', async () => {
  const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ saved: true })) as unknown as typeof fetch)

  await open(rows)

  labelled('Restore')[0]!.click()
  await quiet()
  expect(fetched).not.toHaveBeenCalled()

  confirmFirst()
  await until(() => fetched.mock.calls.length > 0 && document.body.textContent.includes('Restored'))

  const [url, init] = fetched.mock.calls[0]! as [string | URL | Request, RequestInit]

  expect(String(url)).toContain('/trash/notes/200/restore')
  expect(init.method).toBe('POST')
  expect(document.body.textContent).toContain('Restored')
})

test('each Restore and Erase for good is named with its entry, refused or not', async () => {
  const root = await open(rows)
  const names = (label: string) => [...root.querySelectorAll('button')].filter(item => item.textContent?.trim() === label).map(item => item.getAttribute('aria-label')).filter(Boolean)

  expect(names('Restore')).toEqual(['Restore Two', 'Restore One'])
  expect(names('Erase for good')).toEqual(['Erase Two for good', 'Erase One for good'])
  mounted?.unmount()

  mounted = await mountComponent(WithToaster, { trash: { collection: NOTES, rows, denied: { delete: 'No' } } })
  await settle()

  const refused = [...mounted.root.querySelectorAll('button[disabled]')]

  expect(refused.map(item => item.getAttribute('aria-label'))).toEqual(['Erase Two for good', 'Erase One for good'])
})

test('each Restore of a version is named with its date', async () => {
  const entry = { slug: 'hello', version: 'v1', data: {} } as unknown as StoredEntry
  const change = { key: 'title', label: 'Title', before: 'a', after: 'b' }

  mounted = await mountComponent(WithToaster, { versions: { collection: NOTES, entry, rows: [
    { revision: 3, savedAt: new Date(Date.UTC(2026, 2, 3, 9, 30)), verb: 'update', changes: [change], current: true },
    { revision: 2, savedAt: new Date(Date.UTC(2026, 1, 2, 9, 30)), verb: 'update', changes: [change], current: false },
    { revision: 1, savedAt: new Date(Date.UTC(2026, 0, 1, 9, 30)), verb: 'add', changes: [], current: false },
    { revision: 0, verb: 'original', changes: [], current: false },
  ] } })
  await settle()

  const names = [...mounted.root.querySelectorAll('button')].filter(item => item.textContent?.trim() === 'Restore').map(item => item.getAttribute('aria-label'))

  expect(names).toHaveLength(3)
  expect(new Set(names).size).toBe(3)
  expect(names[0]).toMatch(/^Restore the version of .*2026/)
  expect(names[2]).toBe('Restore this version')
})

test('a refused restore toasts why', async () => {
  spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ issues: [{ message: 'second already exists' }] })) as unknown as typeof fetch)
  await open(rows)
  labelled('Restore')[0]!.click()
  await until(() => document.querySelector('dialog[open]') !== null)
  confirmFirst()
  await until(() => document.body.textContent.includes('second already exists'))
  expect(document.body.textContent).toContain('second already exists')
})
