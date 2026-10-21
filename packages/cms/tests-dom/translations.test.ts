import type { Mounted } from 'kay/test'
import type { ScreenCollection } from '../src/kay/contract'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const pages: ScreenCollection = {
  name: 'pages',
  kind: 'folder',
  localized: true,
  locales: ['en', 'fr', 'de'],
  defaultLocale: 'en',
  components: [],
  schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, summary: { type: 'string' } } },
}
const about = { slug: 'about', locale: 'fr', data: { title: 'About', summary: '' }, draft: false, version: 'v1' }
const source = { locale: 'en', slug: 'about', data: { title: 'About', summary: 'Us' } }
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

async function open(props: object) {
  spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json([])) as unknown as typeof fetch)
  mounted = await mountComponent('../../src/components/entry-editor.kay', { prefix: '/admin', collection: pages, ...props })
  await settle()

  return mounted.root
}

test('says under a field that it reads as the default locale\'s, or is empty beside it', async () => {
  const translations = { locales: [{ locale: 'en', slug: 'about' }, { locale: 'fr', slug: 'about' }, { locale: 'de' }], source }
  const root = await open({ entry: about, translations })
  const text = root.textContent ?? ''

  expect(text).toContain('Same as en: not translated yet.')
  expect(text).toContain('Empty: en has a text.')
})

test('links each locale, and starts a missing one as a copy', async () => {
  const translations = { locales: [{ locale: 'en', slug: 'about' }, { locale: 'fr', slug: 'about' }, { locale: 'de' }], source }
  const root = await open({ entry: about, translations })
  const links = [...root.querySelectorAll<HTMLAnchorElement>('.kcms-locales a')].map(link => link.getAttribute('href'))

  expect(links).toContain('/admin/collections/pages/about?locale=en')
  expect(links).toContain('/admin/new/pages?locale=de&from=about&fromLocale=fr')
})

test('a new translation opens as a draft copy of the entry it comes from', async () => {
  const withDraft = { ...pages, draftField: 'draft', schema: { ...pages.schema, properties: { ...pages.schema.properties, draft: { type: 'boolean' } } } }
  const root = await open({ collection: withDraft, locale: 'de', copy: { locale: 'en', slug: 'about', data: { title: 'About', summary: 'Us' } }, source })
  const title = [...root.querySelectorAll<HTMLInputElement>('input')].find(input => input.closest('.kui-form-field')?.textContent?.startsWith('Title'))!

  const draft = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(box => box.closest('label')?.textContent?.includes('Draft'))

  expect(title.value).toBe('About')
  expect(draft?.checked).toBe(true)
})

test('shows the text of the locale compared, and a link to hide it', async () => {
  const translations = { locales: [{ locale: 'en', slug: 'about' }, { locale: 'fr', slug: 'about' }], source, compare: { ...source, data: { title: 'About us', summary: 'Hello there' } } }
  const root = await open({ entry: about, translations })
  const aside = root.querySelector('.kcms-compare')

  expect(aside?.textContent).toContain('Hello there')
  expect([...root.querySelectorAll<HTMLAnchorElement>('.kcms-locales a')].map(link => link.textContent)).toContain('Hide')
})
