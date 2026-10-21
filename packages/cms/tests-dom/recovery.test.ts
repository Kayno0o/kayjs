import type { Mounted } from 'kay/test'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { browserKeeper } from '../src/draft-storage'
import { createDrafts } from '../src/drafts'

const ENTRY = { collection: 'posts', slug: 'hello' }
const COLLECTION = { name: 'posts', title: 'Posts' }
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
})

function memoryStorage(): Storage {
  const items = new Map<string, string>()

  return {
    get length() { return items.size },
    clear: () => items.clear(),
    getItem: key => items.get(key) ?? null,
    key: at => [...items.keys()][at] ?? null,
    removeItem: key => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

async function mountNotices(drafts: ReturnType<typeof createDrafts>) {
  mounted = await mountComponent('src/components/notices.kay', { drafts })
  await settle()

  return mounted.root
}

test('tells the editor their unsaved changes came back, or were left out for an entry saved since', async () => {
  const storage = memoryStorage()
  const before = createDrafts({ show: async () => ({}), keep: browserKeeper(() => storage) })

  before.open({ ...ENTRY, data: { title: 'Hello' } }, 'v1')
  before.set(ENTRY, 'title', 'Mine')
  before.flush()

  const same = createDrafts({ show: async () => ({}), keep: browserKeeper(() => storage) })

  same.open({ ...ENTRY, data: { title: 'Hello' } }, 'v1')
  expect((await mountNotices(same)).textContent).toContain('Your unsaved changes from')
  mounted?.unmount()

  const newer = createDrafts({ show: async () => ({}), keep: browserKeeper(() => storage) })

  before.set(ENTRY, 'title', 'Mine again')
  newer.open({ ...ENTRY, data: { title: 'Theirs' } }, 'v2')
  expect((await mountNotices(newer)).textContent).toContain('were left out')
})

test('a conflict names the fields both sides changed, and offers keeping mine or taking theirs', async () => {
  spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ collection: COLLECTION, entry: { ...ENTRY, data: { title: 'Theirs' }, version: 'v2' } })) as unknown as typeof fetch)

  const drafts = createDrafts({ show: async () => ({}) })

  drafts.open({ ...ENTRY, data: { title: 'Hello' } }, 'v1')
  drafts.set(ENTRY, 'title', 'Mine')
  drafts.refuse(ENTRY, { message: 'saved since', conflict: { version: 'v2' } })

  const root = await mountNotices(drafts)

  for (let wait = 0; wait < 50 && !root.textContent?.includes('Both sides changed'); wait++)
    await Bun.sleep(20)

  expect(root.textContent).toContain('Both sides changed: title.')

  const buttons = [...root.querySelectorAll('button')]

  expect(buttons.map(button => button.textContent?.trim())).toEqual(['Keep my edits', 'Take their version'])
  buttons[1]!.click()
  for (let wait = 0; wait < 50 && drafts.refusal(ENTRY); wait++)
    await Bun.sleep(20)

  expect([drafts.value(ENTRY, 'title'), drafts.version(ENTRY), drafts.changed(ENTRY)]).toEqual(['Theirs', 'v2', false])
})

test('a conflict with a deleted file offers keeping the edits alone', async () => {
  const drafts = createDrafts({ show: async () => ({}) })

  drafts.open({ ...ENTRY, data: { title: 'Hello' } }, 'v1')
  drafts.set(ENTRY, 'title', 'Mine')
  drafts.refuse(ENTRY, { message: 'deleted since', conflict: { version: null } })

  const root = await mountNotices(drafts)

  expect([...root.querySelectorAll('button')].map(button => button.textContent?.trim())).toEqual(['Keep my edits'])
})
