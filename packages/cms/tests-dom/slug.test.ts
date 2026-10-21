import type { Mounted } from 'kay/test'
import type { ScreenCollection } from '../src/kay/contract'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const notes: ScreenCollection = {
  name: 'notes',
  kind: 'folder',
  localized: false,
  components: [],
  schema: { type: 'object', properties: { title: { type: 'string' } } },
}
const STORED = [{ slug: 'hello' }, { slug: 'guides/start' }, { slug: 'guides/2024/recap' }]
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

async function open(collection: ScreenCollection = notes, stored: object[] = STORED, prefix = '/admin') {
  spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json(stored)) as unknown as typeof fetch)
  mounted = await mountComponent('../../src/components/entry-editor.kay', { prefix, collection })
  await settle()

  return mounted.root
}

async function type(root: ParentNode, label: string, text: string): Promise<void> {
  const box = [...root.querySelectorAll<HTMLInputElement>('input')].find(input => input.closest('.kui-form-field')?.textContent?.includes(label))!

  box.value = text
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

const slugBox = (root: ParentNode) => [...root.querySelectorAll<HTMLInputElement>('input')].find(input => input.closest('.kui-form-field')?.textContent?.startsWith('Slug'))!

test('writes the slug from an accented French title as it is typed, until the slug is typed in', async () => {
  const root = await open()

  await type(root, 'Title', 'Été à la ferme : Œufs')
  expect(slugBox(root).value).toBe('ete-a-la-ferme-oeufs')
  await type(root, 'Slug', 'Mon Titre')
  expect(slugBox(root).value).toBe('mon-titre')
  await type(root, 'Title', 'Autre chose')
  expect(slugBox(root).value).toBe('mon-titre')
})

test('the option to write it from the title can be turned off, and on again by clearing the slug', async () => {
  const root = await open()
  const option = () => [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(box => box.closest('label')?.textContent?.includes('Write it from the title'))!

  expect(option().checked).toBe(true)
  option().click()
  await settle()
  await type(root, 'Title', 'Bonjour')
  expect(slugBox(root).value).toBe('')

  await type(root, 'Slug', 'a')
  await type(root, 'Slug', '')
  expect(option().checked).toBe(true)
  await type(root, 'Title', 'Bonjour le monde')
  expect(slugBox(root).value).toBe('bonjour-le-monde')
})

test('cleans a typed slug of accents, spaces and case, keeping the slashes between folders', async () => {
  const root = await open()

  await type(root, 'Slug', 'Guides / Déjà Vu ')
  expect(slugBox(root).value).toBe('guides/deja-vu-')
})

test('flags a taken slug as it is typed, marking the field invalid', async () => {
  const root = await open()

  await type(root, 'Slug', 'hello')
  expect(root.querySelector('.kui-form-field-issue')?.textContent).toBe('An entry with this slug already exists: pick another slug')
  expect(slugBox(root).getAttribute('aria-invalid')).toBe('true')
  await type(root, 'Slug', 'hello-2')
  expect(root.querySelector('.kui-form-field-issue')).toBeNull()
})

test('says which folder a slug lands in, which it creates, and the existing one a typo looks like', async () => {
  const root = await open()
  const hint = () => root.querySelector('.kui-form-field-hint')?.textContent

  await type(root, 'Slug', 'guides/2024/other')
  expect(hint()).toBe('In the folder guides/2024')
  await type(root, 'Slug', 'guides/2025/other')
  expect(hint()).toBe('Creates the folder guides/2025')
  await type(root, 'Slug', 'guidse/other')
  expect(hint()).toBe('No folder guidse yet: did you mean guides?')
  await type(root, 'Slug', 'other')
  expect(hint()).toBe('The file\'s path in the collection\'s folder, with / between folders')
})

test('keeps a loaded collection\'s slug as typed, with no suggestion and no folder hint', async () => {
  const root = await open({ ...notes, kind: 'loaded' })

  await type(root, 'Title', 'Hello World')
  expect(slugBox(root).value).toBe('')
  await type(root, 'Slug', 'Some Id/7')
  expect(slugBox(root).value).toBe('Some Id/7')
  expect(root.querySelector('.kui-form-field-hint')).toBeNull()
  expect([...root.querySelectorAll('label')].some(label => label.textContent?.includes('from the title'))).toBe(false)
})

test('leaves the form working when the slugs cannot be read', async () => {
  spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('no', { status: 500 })) as unknown as typeof fetch)
  mounted = await mountComponent('../../src/components/entry-editor.kay', { prefix: '/admin', collection: notes })
  await settle()
  await type(mounted.root, 'Slug', 'hello')
  expect(mounted.root.querySelector('.kui-form-field-issue')).toBeNull()
})

test('a slug is taken in its own locale only', async () => {
  const root = await open({ ...notes, localized: true, locales: ['fr', 'en'] }, [{ slug: 'hello', locale: 'fr' }, { slug: 'only-en', locale: 'en' }])

  await type(root, 'Slug', 'hello')
  expect(root.querySelector('.kui-form-field-issue')?.textContent).toContain('already exists')
  await type(root, 'Slug', 'only-en')
  expect(root.querySelector('.kui-form-field-issue')).toBeNull()
})

test('writes the slug from a Cyrillic title, and says why when the title has no letter or digit', async () => {
  const root = await open()

  await type(root, 'Title', 'Привет, Мир')
  expect(slugBox(root).value).toBe('привет-мир')
  await type(root, 'Title', '!?!')
  expect(slugBox(root).value).toBe('')
  expect(root.textContent).toContain('no letter or digit')
})
