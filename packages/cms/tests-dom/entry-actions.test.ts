import type { Mounted } from 'kay/test'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const POSTS: ScreenCollection = {
  name: 'posts',
  kind: 'folder',
  localized: false,
  components: [],
  draftField: 'draft',
  publishField: 'publishAt',
  schema: { type: 'object', properties: { title: { type: 'string' }, draft: { type: 'boolean' }, publishAt: { type: 'string' } } },
}
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
const stored = (data: Record<string, unknown>, more: Partial<StoredEntry> = {}) => ({ slug: 'hello', data: { title: 'Hello', draft: false, ...data }, draft: false, version: 'v1', url: '/posts/hello', ...more }) as unknown as StoredEntry
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
})

// The entries API answering each save with `answer`, held until `release` when `hold` is set.
function server(answer: object = { saved: true, version: 'v2' }, hold = false) {
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetched = spyOn(globalThis, 'fetch').mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
    // The version another save left, which a conflict reads.
    if (init?.method !== 'POST')
      return Response.json({ collection: POSTS, entry: stored({ title: 'Theirs' }, { version: 'v9' }) })

    if (hold)
      await held

    return Response.json(answer)
  }) as unknown as typeof fetch)

  return { fetched, release }
}

const sentData = (fetched: ReturnType<typeof server>['fetched'], at = 0) => JSON.parse(String((fetched.mock.calls[at]![1] as RequestInit).body)) as { data: Record<string, unknown>, locale?: string }

async function open(entry: StoredEntry | undefined = stored({}), collection: ScreenCollection = POSTS) {
  mounted = await mountComponent('../../src/components/entry-editor.kay', { prefix: '/admin', collection, entry })
  await settle()

  return mounted.root
}

const button = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find(each => each.textContent?.trim() === label)
const title = (root: ParentNode) => root.querySelector<HTMLInputElement>('[data-kcms-path="title"] input')!
const state = (root: ParentNode) => root.querySelector('.kcms-save-state')!.textContent.trim()
const buttons = (root: ParentNode) => [...root.querySelectorAll('.kcms-entry-actions button')].map(each => each.textContent?.trim())

async function type(root: ParentNode, text: string): Promise<void> {
  title(root).value = text
  title(root).dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

async function pause(): Promise<void> {
  for (let wait = 0; wait < 10; wait++) {
    await Bun.sleep(5)
    await settle()
  }
}

test('Save waits for an edit, the state line says so, and a save locks the form and says when it ended', async () => {
  const { fetched, release } = server({ saved: true, version: 'v2' }, true)
  const root = await open()
  const save = () => button(root, 'Save') ?? button(root, 'Saving…')!

  expect(save().disabled).toBe(true)
  expect(state(root)).toBe('')

  await type(root, 'Hello again')
  expect(save().disabled).toBe(false)
  expect(state(root)).toBe('Unsaved changes')

  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(state(root)).toBe('Saving…')
  expect(save().textContent?.trim()).toBe('Saving…')
  expect(root.querySelector('fieldset')!.disabled).toBe(true)
  expect(root.querySelector('form')!.getAttribute('aria-busy')).toBe('true')

  release()
  await pause()
  expect(state(root)).toMatch(/^Saved at /)
  expect(state(root)).not.toContain('Not live')
  expect(root.querySelector('fieldset')!.disabled).toBe(false)
  expect(save().disabled).toBe(true)
  expect(sentData(fetched).data.title).toBe('Hello again')
})

test('a save the site shows only once rebuilt says so, with a link to the public page', async () => {
  server({ saved: true, version: 'v2', commit: { sha: 'abc' } })

  const root = await open()

  await type(root, 'Rebuilt')
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await pause()
  expect(state(root)).toMatch(/Not live yet: the site shows it once it has rebuilt\./)

  const link = root.querySelector<HTMLAnchorElement>('.kcms-save-state a')

  expect(link?.textContent).toBe('View the page')
  expect(link?.getAttribute('href')).toBe('/posts/hello')
  expect(link?.getAttribute('target')).toBe('_blank')
})

test('Reset appears once edited, and puts the title back', async () => {
  const root = await open()

  expect(button(root, 'Reset')).toBeUndefined()
  await type(root, 'Other')
  expect(button(root, 'Reset')).toBeDefined()
  button(root, 'Reset')!.click()
  await settle()
  // Asked first: the title stays until the dialog's Reset is pressed.
  expect(title(root).value).toBe('Other')
  ;[...document.querySelectorAll('button')].filter(item => item.textContent?.trim() === 'Reset').at(-1)!.click()
  await settle()
  expect(title(root).value).toBe('Hello')
  expect(button(root, 'Reset')).toBeUndefined()
})

test('a draft shows its badge and Publish, which saves the entry as public alone', async () => {
  const { fetched } = server()
  const root = await open(stored({ draft: true }))

  expect(root.querySelector('header')!.textContent).toContain('Draft')
  expect(buttons(root)).toContain('Publish')
  expect(buttons(root)).not.toContain('Unpublish')
  button(root, 'Publish')!.click()
  await pause()
  expect(sentData(fetched).data).toMatchObject({ title: 'Hello', draft: false })
  expect(buttons(root)).not.toContain('Publish')
  expect(root.querySelector('header')!.textContent).not.toContain('Draft')
})

test('a refused publish puts the field back, naming a conflict, and the entry stays a draft', async () => {
  server({ issues: [{ path: '', message: 'The file changed since you opened it' }], conflict: { version: 'v9' } })

  const root = await open(stored({ draft: true }))

  button(root, 'Publish')!.click()
  await pause()
  expect(buttons(root)).toContain('Publish')
  expect(root.querySelector('header')!.textContent).toContain('Draft')
  expect(button(root, 'Save')!.disabled).toBe(true)
  expect(root.querySelector('.kcms-refusal')?.textContent).toContain('The file changed since you opened it')
})

test('Publish and Unpublish wait for unsaved edits instead of saving them too', async () => {
  const { fetched } = server()
  const root = await open(stored({}))

  await type(root, 'Edited')
  expect(button(root, 'Unpublish')).toBeDefined()
  button(root, 'Unpublish')!.click()
  await pause()
  expect(fetched).not.toHaveBeenCalled()
})

test('a published entry offers Unpublish behind a question', async () => {
  const root = await open(stored({}))

  expect(buttons(root)).not.toContain('Publish')
  expect(buttons(root)).toContain('Unpublish')
})

test('a scheduled entry shows its badge with Publish now and Clear schedule, each saving that field alone', async () => {
  const { fetched } = server()
  const root = await open(stored({ publishAt: FUTURE }))

  expect(root.textContent).toContain('Scheduled for')
  expect(buttons(root)).toEqual(expect.arrayContaining(['Publish now', 'Clear schedule']))
  button(root, 'Clear schedule')!.click()
  await pause()
  expect('publishAt' in sentData(fetched).data).toBe(false)
  expect(root.textContent).not.toContain('Scheduled for')
  expect(buttons(root)).not.toContain('Clear schedule')

  fetched.mockClear()
  mounted?.unmount()

  const again = await open(stored({ publishAt: FUTURE }))

  button(again, 'Publish now')!.click()
  await pause()
  expect(Date.parse(String(sentData(fetched).data.publishAt))).toBeLessThanOrEqual(Date.now())
  expect(again.textContent).not.toContain('Scheduled for')
})

test('Delete asks with the page it takes down, and a single collection has none', async () => {
  const root = await open(stored({}))

  expect(buttons(root)).toContain('Delete')
  button(root, 'Delete')!.click()
  await settle()
  expect(document.body.textContent).toContain('Its page /posts/hello stops answering, and links to it break.')
  mounted?.unmount()

  const single = await open(stored({}), { ...POSTS, single: true })

  expect(buttons(single)).not.toContain('Delete')
})

test('a localized entry is published with its locale', async () => {
  const { fetched } = server()
  const root = await open(stored({ draft: true }, { locale: 'fr' }), { ...POSTS, localized: true, locales: ['en', 'fr'] })

  button(root, 'Publish')!.click()
  await pause()
  expect(sentData(fetched).locale).toBe('fr')
})

test('Ctrl+S in a field saves and leaves the caret in it once the save ends', async () => {
  const { fetched, release } = server({ saved: true, version: 'v2' }, true)
  const root = await open()

  await type(root, 'Typed')
  title(root).focus()
  expect(document.activeElement).toBe(title(root))
  title(root).dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
  await settle()
  expect(root.querySelector('fieldset')!.disabled).toBe(true)
  // A browser drops the focus of a field its fieldset disabled; happy-dom does not.
  title(root).blur()
  release()
  await pause()
  expect(fetched).toHaveBeenCalledTimes(1)
  expect(root.querySelector('fieldset')!.disabled).toBe(false)
  expect(document.activeElement).toBe(title(root))
})

test('a role that may not publish or delete sees those buttons disabled, with the reason as their tooltip', async () => {
  mounted = await mountComponent('../../src/components/entry-editor.kay', { prefix: '/admin', collection: POSTS, entry: stored({ draft: true }), denied: { publish: 'Your role may not publish', delete: 'Your role may not delete' } })
  await settle()

  const { root } = mounted

  for (const label of ['Publish', 'Delete']) {
    const control = button(root, label)!

    expect(control.disabled, label).toBe(true)
    expect(control.closest('[data-tooltip]')?.getAttribute('data-tooltip'), label).toBe(label === 'Publish' ? 'Your role may not publish' : 'Your role may not delete')
  }

  // Saving stays, since editing is every role's.
  expect(button(root, 'Save')).toBeDefined()
})

test('a role holding every action sees the enabled buttons', async () => {
  const root = await open(stored({ draft: true }))

  expect(button(root, 'Publish')!.disabled).toBe(false)
  expect(root.querySelector('.kcms-refused')).toBeNull()
})
