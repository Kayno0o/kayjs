import type { Mounted } from 'kay/test'
import type { ScreenCollection } from '../src/kay/contract'
import type { TrashScreen } from '../src/screens'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const NOTES: ScreenCollection = {
  name: 'notes',
  kind: 'loaded',
  localized: false,
  components: [],
  schema: { type: 'object', properties: { title: { type: 'string' } } },
}
const rows: TrashScreen['rows'] = [
  { id: '200', at: 200, author: 'Ada', slug: 'second', title: 'Two' },
  { id: '100', at: 100, slug: 'first', locale: 'fr', title: 'One' },
]
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
})

async function open(shown: TrashScreen['rows']): Promise<ParentNode> {
  mounted = await mountComponent('../../tests-dom/with-toaster.kay', { trash: { collection: NOTES, rows: shown } })
  await settle()

  return mounted.root
}

async function pause(): Promise<void> {
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
  await pause()
  expect(fetched).not.toHaveBeenCalled()

  confirmFirst()
  await pause()

  const [url, init] = fetched.mock.calls[0]! as [string | URL | Request, RequestInit]

  expect(String(url)).toContain('/trash/notes/200/restore')
  expect(init.method).toBe('POST')
  expect(document.body.textContent).toContain('Restored')
})

test('a refused restore toasts why', async () => {
  spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ issues: [{ message: 'second already exists' }] })) as unknown as typeof fetch)
  await open(rows)
  labelled('Restore')[0]!.click()
  await pause()
  confirmFirst()
  await pause()
  expect(document.body.textContent).toContain('second already exists')
})
