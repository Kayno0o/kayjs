import type { Mounted } from 'kay/test'
import { join } from 'node:path'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const EDITOR = join(import.meta.dir, '../src/editor/editor.kay')
const ENTRY = { collection: 'posts', slug: 'hello' }
let mounted: Mounted | undefined

// happy-dom has no caret lookup, which the editor's click handler asks.
Object.assign(document, { caretPositionFromPoint: () => null })

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
  localStorage.clear()
})

const COLLECTION = { name: 'posts', title: 'Posts', schema: { type: 'object', properties: { title: { type: 'string' } } } }

// The entries API answering the form's read with a stored entry, and everything else as the leave.
function server(leave: Response = Response.json({ left: true })) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => init?.method === 'POST' ? leave.clone() : Response.json({ collection: COLLECTION, entry: { ...ENTRY, data: { title: 'Hello' }, version: 'v1' } })) as unknown as typeof fetch)
}

const left = (fetched: ReturnType<typeof server>) => fetched.mock.calls.some(([url]) => String(url).endsWith('/exit'))

// Opens the editor on the entry and types into its title, which leaves it with edits not saved.
async function typed(): Promise<ParentNode> {
  mounted = await mountComponent(EDITOR, { entries: [ENTRY] })
  await settle()
  await Bun.sleep(50)

  const title = mounted.root.querySelector<HTMLInputElement>('input')!

  title.value = 'Mine'
  title.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  // The edit is kept in the browser after the render's pause.
  await Bun.sleep(200)

  return mounted.root
}

// How many drafts the browser keeps, apart from the editor's dock.
const kept = () => Object.keys(localStorage).filter(key => key.startsWith('kcms:draft:')).length

const stop = (root: ParentNode) => [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Stop editing')!
const labels = (root: ParentNode) => [...root.querySelectorAll('button')].map(button => button.textContent?.trim())

test('Stop editing with nothing unsaved leaves at once', async () => {
  const fetched = server()

  mounted = await mountComponent(EDITOR, { entries: [ENTRY] })
  await settle()
  await Bun.sleep(50)
  stop(mounted.root).click()
  await settle()

  expect(mounted.root.querySelector('.kcms-editor-confirm')).toBeNull()
  expect(left(fetched)).toBe(true)
})

test('Stop editing with unsaved edits asks first, and Keep editing leaves the edits and the edit mode alone', async () => {
  const fetched = server()
  const root = await typed()

  stop(root).click()
  await settle()

  const confirm = root.querySelector('.kcms-editor-confirm')

  expect(confirm?.textContent).toContain('not saved')
  expect(labels(confirm!)).toEqual(['Keep editing', 'Drop them and stop'])
  expect(left(fetched)).toBe(false)

  confirm!.querySelectorAll('button')[0]!.click()
  await settle()

  expect(root.querySelector('.kcms-editor-confirm')).toBeNull()
  expect(root.querySelector<HTMLInputElement>('input')!.value).toBe('Mine')
  expect(left(fetched)).toBe(false)
})

test('Drop them and stop leaves the edit mode', async () => {
  const fetched = server()
  const root = await typed()

  stop(root).click()
  await settle()
  root.querySelectorAll<HTMLButtonElement>('.kcms-editor-confirm button')[1]!.click()
  await settle()
  await Bun.sleep(50)

  expect(left(fetched)).toBe(true)
  expect(kept()).toBe(0)
})

test('a leave that fails keeps the edits', async () => {
  server(new Response('no', { status: 500 }))

  const root = await typed()

  stop(root).click()
  await settle()
  root.querySelectorAll<HTMLButtonElement>('.kcms-editor-confirm button')[1]!.click()
  await settle()
  await Bun.sleep(50)

  expect(root.querySelector<HTMLInputElement>('input')!.value).toBe('Mine')
  expect(kept()).toBe(1)
})

test('Stop editing pressed again while the question shows asks again and leaves nothing', async () => {
  const fetched = server()
  const root = await typed()

  stop(root).click()
  await settle()
  stop(root).click()
  await settle()

  expect(root.querySelector('.kcms-editor-confirm')).not.toBeNull()
  expect(left(fetched)).toBe(false)
  expect(kept()).toBe(1)
})

test('a reload brings the typed edits back, and Reset drops them for good', async () => {
  server()
  localStorage.clear()

  const root = await typed()

  expect(kept()).toBe(1)
  mounted!.unmount()
  mounted = undefined

  mounted = await mountComponent(EDITOR, { entries: [ENTRY] })
  await settle()
  await Bun.sleep(50)

  expect(mounted.root.querySelector<HTMLInputElement>('input')!.value).toBe('Mine')
  expect(mounted.root.textContent).toContain('Your unsaved changes from')
  expect(root).not.toBe(mounted.root)

  const reset = [...mounted.root.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Reset')!

  reset.click()
  await settle()

  expect(kept()).toBe(0)
})

test('closing or reloading the tab with edits not saved gets the browser prompt, and not once they are gone', async () => {
  server()

  const root = await typed()
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true })

    window.dispatchEvent(event)

    return event.defaultPrevented
  }

  expect(unload()).toBe(true)
  ;[...root.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Reset')!.click()
  await settle()

  expect(unload()).toBe(false)
})
