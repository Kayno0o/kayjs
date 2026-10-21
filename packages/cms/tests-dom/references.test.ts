import type { Mounted } from 'kay/test'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const NOTES: ScreenCollection = {
  name: 'notes',
  kind: 'folder',
  localized: false,
  components: [],
  schema: { type: 'object', properties: { title: { type: 'string' }, post: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'posts' } } } },
}
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
})

// The picker's reader of choices, taken from a bundle of its own so the reads in a test share one cache.
async function reader(): Promise<(collection: string) => Promise<{ value: string, label: string }[]>> {
  let read: ((collection: string) => Promise<{ value: string, label: string }[]>) | undefined

  mounted = await mountComponent('../../tests-dom/reference-reads.kay', { expose: (found: typeof read) => {
    read = found
  } })

  return read!
}

interface Answer { choices: { slug: string, title: string }[], complete: boolean }

// The entries API answering the picker's read of a collection with `answer`, held until `release` when `hold` is set.
function server(answer: () => Answer | Response, hold = false) {
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => {
    if (hold)
      await held

    const made = answer()

    return made instanceof Response ? made : Response.json(made)
  }) as unknown as typeof fetch)

  return { fetched, release }
}

const POSTS = { choices: [{ slug: 'hello', title: 'Hello' }, { slug: 'plain', title: 'plain' }], complete: true }

test('the choices are labelled by title and slug, and shared by the reads made within a few seconds', async () => {
  const { fetched } = server(() => POSTS)

  const referenceChoices = await reader()
  const first = referenceChoices('shared')
  const second = referenceChoices('shared')

  expect(await first).toEqual([{ value: 'hello', label: 'Hello (hello)' }, { value: 'plain', label: 'plain' }])
  expect(await second).toEqual(await first)
  expect(fetched).toHaveBeenCalledTimes(1)
})

test('a read is kept for a few seconds, then read again', async () => {
  const { fetched } = server(() => POSTS)
  const timers: (() => void)[] = []
  const referenceChoices = await reader()

  spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void) => {
    timers.push(run)

    return 0
  }) as unknown as typeof setTimeout)

  await referenceChoices('kept')
  await referenceChoices('kept')
  expect(fetched).toHaveBeenCalledTimes(1)

  for (const run of timers)
    run()

  await referenceChoices('kept')
  expect(fetched).toHaveBeenCalledTimes(2)
})

test('a failed read is dropped at once, so the next one asks again', async () => {
  let failing = true
  const referenceChoices = await reader()
  const { fetched } = server(() => failing ? new Response('nope', { status: 500 }) : POSTS)

  await expect(referenceChoices('flaky')).rejects.toThrow()
  failing = false

  expect(await referenceChoices('flaky')).toHaveLength(2)
  expect(fetched).toHaveBeenCalledTimes(2)
})

test('a collection too large to list rejects, and is not kept either', async () => {
  const { fetched } = server(() => ({ choices: [], complete: false }))
  const referenceChoices = await reader()

  await expect(referenceChoices('huge')).rejects.toThrow('too many entries to list')
  await expect(referenceChoices('huge')).rejects.toThrow('too many entries to list')
  expect(fetched).toHaveBeenCalledTimes(2)
})

async function open(held: string | undefined) {
  const entry = { slug: 'n', data: { title: 'N', ...held === undefined ? {} : { post: held } }, draft: false, version: 'v1', url: '/notes/n' } as unknown as StoredEntry

  mounted = await mountComponent('src/components/entry-screen.kay', { collection: NOTES, entry })
  await settle()

  const field = () => mounted!.root.querySelector<HTMLElement>('[data-kcms-path="post"]')!

  return { field }
}

// The option marked selected, which a browser shows chosen.
const chosen = (select: HTMLSelectElement) => [...select.options].find(option => option.hasAttribute('selected'))?.value

async function pause(): Promise<void> {
  for (let wait = 0; wait < 10; wait++) {
    await Bun.sleep(5)
    await settle()
  }
}

test('the picker shows it is loading, then lists the entries with the held one selected', async () => {
  const { release } = server(() => ({ choices: [{ slug: 'hello', title: 'Hello' }, { slug: 'other', title: 'Other' }], complete: true }), true)
  const { field } = await open('hello')
  const select = () => field().querySelector('select')!

  expect(select().querySelector('option[disabled]')?.textContent).toContain('Loading')

  release()
  await pause()
  expect([...select().options].map(option => option.value)).toEqual(['', 'hello', 'other'])
  expect(chosen(select())).toBe('hello')
})

test('a collection that cannot be listed falls back to typing the slug', async () => {
  server(() => ({ choices: [], complete: false }))

  const { field } = await open('hello')

  await pause()
  expect(field().querySelector('select')).toBeNull()
  expect(field().querySelector<HTMLInputElement>('input')!.value).toBe('hello')
})

test('a held value the collection lacks stays among the choices, so it shows rather than vanishes', async () => {
  server(() => ({ choices: [{ slug: 'hello', title: 'Hello' }], complete: true }))

  const { field } = await open('gone')

  await pause()

  const select = field().querySelector('select')!

  expect([...select.options].map(option => option.value)).toEqual(['', 'gone', 'hello'])
  expect(chosen(select)).toBe('gone')
})
