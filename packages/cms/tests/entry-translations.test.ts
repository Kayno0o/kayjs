import type * as Content from '../src/kay/content'
import type { EntryFilter, ScreenCollection, SourceEntry, StoredEntry } from '../src/kay/contract'
import { describe, expect, it, mock } from 'bun:test'

const stock: SourceEntry[] = [
  { slug: 'a-propos', locale: 'fr', data: { title: 'A propos', translationKey: 'about' }, draft: false },
  { slug: 'about', locale: 'en', data: { title: 'About', translationKey: 'about' }, draft: false },
  { slug: 'hello', locale: 'en', data: { title: 'Hello' }, draft: false },
]
const asked: EntryFilter[] = []

const content: Partial<typeof Content> = {
  ...await import('kay/content'),
  translations: async () => new Map([['about', new Map([['fr', 'a-propos'], ['en', 'about']])], ['hello', new Map([['en', 'hello']])]]),
  entries: async (_collection, filter = {}) => {
    asked.push(filter)

    return stock.filter(entry => (filter.slug === undefined || entry.slug === filter.slug) && (filter.locale === undefined || entry.locale === filter.locale))
  },
}

void mock.module('../src/kay/content', () => content)

const { entryTranslations } = await import('../src/screens')

const pages = { name: 'pages', kind: 'loaded', localized: true, locales: ['fr', 'en', 'de'], defaultLocale: 'fr', components: [], schema: {} } as ScreenCollection
const stored = (entry: SourceEntry) => entry as StoredEntry

describe('entryTranslations', () => {
  it('finds a translation under another slug and reads the default locale\'s entry and the compared one, nothing else', async () => {
    asked.length = 0

    const found = await entryTranslations(pages, stored(stock[1]!), 'de')

    expect(found?.locales).toEqual([{ locale: 'fr', slug: 'a-propos' }, { locale: 'en', slug: 'about' }, { locale: 'de', slug: undefined }])
    expect(found?.source).toMatchObject({ locale: 'fr', slug: 'a-propos' })
    expect(found?.compare).toBeUndefined()
    expect(asked).toEqual([{ slug: 'a-propos', locale: 'fr' }])
  })

  it('reads the compared locale\'s entry, and none for an entry the index does not know', async () => {
    const found = await entryTranslations(pages, stored(stock[0]!), 'en')

    expect(found?.source).toBeUndefined()
    expect(found?.compare).toMatchObject({ locale: 'en', slug: 'about' })

    const alone = await entryTranslations(pages, stored({ slug: 'new', locale: 'en', data: {}, draft: false }))

    expect(alone?.locales).toEqual([{ locale: 'fr' }, { locale: 'en', slug: 'new' }, { locale: 'de' }])
    expect(alone?.source).toBeUndefined()
  })
})
