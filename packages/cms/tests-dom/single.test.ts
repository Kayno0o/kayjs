import type { Mounted } from 'kay/test'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

const home: ScreenCollection = {
  name: 'home',
  title: 'Home page',
  single: true,
  seed: { headline: 'Welcome' },
  kind: 'folder',
  localized: false,
  components: [],
  schema: { type: 'object', properties: { headline: { type: 'string' } } },
}
const written: StoredEntry = { slug: 'index', data: { headline: 'Hello' }, draft: false }
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open(entry?: StoredEntry, collection = home, prefix = '/admin') {
  mounted = await mountComponent('../../src/components/entry-editor.kay', { prefix, collection, entry })

  return mounted.root
}

const buttons = (root: ParentNode) => [...root.querySelectorAll('button')].map(button => button.textContent?.trim())

test('a single collection not written yet opens a form titled with its name, with no slug field, filled with its seed', async () => {
  const root = await open()

  expect(root.querySelector('h1')?.textContent).toBe('Home page')
  expect(root.querySelector('.kcms-entry-subtitle')).toBeNull()
  expect(root.querySelectorAll('input')).toHaveLength(1)
  expect(root.querySelector('input')?.value).toBe('Welcome')
  expect(root.querySelector('.kcms-entry-crumb')?.getAttribute('href')).toBe('/admin')
  expect(buttons(root)).toContain('Create')
})

test('a single collection\'s entry has the collection\'s name, not its slug, and no Delete', async () => {
  const root = await open(written)

  expect(root.querySelector('h1')?.textContent).toBe('Home page')
  expect(root.querySelector('.kcms-entry-subtitle')).toBeNull()
  expect(root.querySelector('input')?.value).toBe('Hello')
  expect(buttons(root)).toContain('Save')
  expect(buttons(root)).not.toContain('Delete')
})

test('a collection that is not single keeps its slug field, its Delete and its list as the way back', async () => {
  const root = await open(written, { ...home, single: undefined, seed: undefined })

  expect(root.querySelector('h1')?.textContent).toBe('Hello')
  expect([...root.querySelectorAll('.kcms-entry-crumb')].map(link => link.getAttribute('href'))).toEqual(['/admin', '/admin/collections/home'])
  expect(buttons(root)).toContain('Delete')
})

test('the way back from a single collection under the root prefix is the content list at /', async () => {
  const root = await open(written, home, '/')

  expect(root.querySelector('.kcms-entry-crumb')?.getAttribute('href')).toBe('/')
})
