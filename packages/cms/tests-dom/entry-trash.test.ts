import type { Mounted } from 'kay/test'
import type { ScreenCollection } from '../src/kay/contract'
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

test('a refused restore toasts why', async () => {
  spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ issues: [{ message: 'second already exists' }] })) as unknown as typeof fetch)
  await open(rows)
  labelled('Restore')[0]!.click()
  await until(() => document.querySelector('dialog[open]') !== null)
  confirmFirst()
  await until(() => document.body.textContent.includes('second already exists'))
  expect(document.body.textContent).toContain('second already exists')
})
