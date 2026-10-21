import type { CollectionInfo, SourceEntry } from '../src/kay/contract'
import { describe, expect, it } from 'bun:test'
import { pageRows } from '../src/listing'
import { fieldGaps, gapOf, groupEntries, missingLocales, pairKey, translationReport } from '../src/translations'

const pages: CollectionInfo = {
  name: 'pages',
  kind: 'folder',
  localized: true,
  locales: ['en', 'fr', 'de'],
  defaultLocale: 'en',
  components: [],
  body: { kind: 'markdown' },
  schema: { required: ['title'], properties: { title: { type: 'string' }, summary: { type: 'string' }, email: { type: 'string', format: 'email' }, code: { 'type': 'string', 'x-kay-translate': false } } },
}

const entry = (slug: string, locale: string, data: SourceEntry['data'], body?: string, more: Partial<SourceEntry> = {}): SourceEntry => ({ slug, locale, data, body, draft: false, ...more })

describe('pairing', () => {
  it('pairs by translationKey, else by slug', () => {
    expect(pairKey({ slug: 'about', data: {} })).toBe('about')
    expect(pairKey({ slug: 'a-propos', data: { translationKey: 'about' } })).toBe('about')
    expect(pairKey({ slug: 'a-propos', data: { translationKey: '' } })).toBe('a-propos')
  })

  it('lists the locales a group lacks', () => {
    const groups = groupEntries([entry('about', 'en', {}), entry('a-propos', 'fr', { translationKey: 'about' }), entry('about', 'en', {}, undefined, { locale: undefined })])

    expect([...groups.keys()]).toEqual(['about'])
    expect(missingLocales(['en', 'fr', 'de'], groups.get('about')!)).toEqual(['de'])
  })
})

describe('gapOf', () => {
  it('is same for the source\'s text, empty for none, and nothing when translated or nothing to translate', () => {
    expect(gapOf(' Hello ', 'Hello')).toBe('same')
    expect(gapOf('', 'Hello')).toBe('empty')
    expect(gapOf(undefined, 'Hello')).toBe('empty')
    expect(gapOf('Bonjour', 'Hello')).toBeUndefined()
    expect(gapOf('', '')).toBeUndefined()
    expect(gapOf('x', undefined)).toBeUndefined()
  })
})

describe('fieldGaps', () => {
  it('leaves out an address, a field opted out and what is translated, and counts the body', () => {
    const source = entry('about', 'en', { title: 'About', summary: 'Us', email: 'a@b.fr', code: 'X1' }, 'Text')
    const copy = entry('about', 'fr', { title: 'About', summary: 'Nous', email: 'a@b.fr', code: 'X1' }, '')

    expect(fieldGaps(pages, copy, source)).toEqual([{ field: 'title', gap: 'same' }, { field: 'body', gap: 'empty' }])
  })
})

describe('translationReport', () => {
  it('lists the entries missing a locale or holding an untranslated text, in order, none for a complete one', () => {
    const rows = translationReport(pages, [
      entry('about', 'en', { title: 'About' }),
      entry('about', 'fr', { title: 'A propos' }),
      entry('about', 'de', { title: 'Uber' }),
      entry('home', 'en', { title: 'Home' }),
      entry('accueil', 'fr', { title: 'Home', translationKey: 'home' }),
    ])

    expect(rows).toEqual([{ key: 'home', slugs: { en: 'home', fr: 'accueil' }, missing: ['de'], gaps: { fr: [{ field: 'title', gap: 'same' }] } }])
  })
})

describe('pageRows', () => {
  it('marks a row with the locales its entry lacks, across slugs', async () => {
    const all = [entry('about', 'en', { title: 'About' }), entry('a-propos', 'fr', { title: 'A propos', translationKey: 'about' }), entry('home', 'en', { title: 'Home' })]
    const listed = await pageRows({ ...pages, count: 3 }, '', 1, async () => all, async () => undefined)

    expect(listed.rows.map(row => [row.slug, row.missing])).toEqual([['about', ['de']], ['a-propos', ['de']], ['home', ['fr', 'de']]])
  })

  it('marks nothing in a collection that is not localized', async () => {
    const listed = await pageRows({ ...pages, localized: false, count: 1 }, '', 1, async () => [entry('about', 'en', { title: 'About' })], async () => undefined)

    expect(listed.rows[0]?.missing).toBeUndefined()
  })
})
