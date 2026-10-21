import type { ScreenCollection, StoredEntry } from '../../../src/kay/contract'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// The form pulls in kayjs-ui's icons, which the site's build resolves.
await testSite({ root: join(import.meta.dir, '..') })

const { createEntryForm, createShown } = await import('../../../src/form')
const { onPagePath } = await import('../../../src/listing')
const { screenPath } = await import('../../../src/paths')

const posts: ScreenCollection = { name: 'posts', kind: 'folder', localized: false, components: [], schema: { properties: { title: { type: 'string' } } } }
const entry = (slug: string, title: string, locale?: string): StoredEntry => ({ slug, locale, data: { title }, draft: false, version: 'v1', url: `/blog/${slug}` }) as StoredEntry

describe('createShown', () => {
  test('counts a field rendered twice, and it is shown until the last render goes', () => {
    const shown = createShown()
    const first = shown.add('title')
    const second = shown.add('title')

    expect(shown.has('title')).toBe(true)
    expect(shown.has('body')).toBe(false)
    first()
    expect(shown.has('title')).toBe(true)
    second()
    expect(shown.has('title')).toBe(false)
  })

  test('is one scope per call, so two forms share nothing', () => {
    const one = createShown()
    const other = createShown()

    one.add('title')
    expect(other.has('title')).toBe(false)
  })
})

describe('a scheduled entry\'s form', () => {
  const talks: ScreenCollection = { name: 'talks', kind: 'folder', localized: false, components: [], publishField: 'at', draftField: 'draft', schema: { properties: { title: { type: 'string' }, at: { type: 'string', format: 'date-time' }, draft: { type: 'boolean' } } } }
  const ahead = new Date(Date.now() + 86_400_000).toISOString()
  const scheduledEntry = (data: Record<string, unknown>) => ({ ...entry('talk', 'Talk'), data }) as StoredEntry

  test('says when the entry goes live while its date is ahead and it is no draft, following the edits', () => {
    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: scheduledEntry({ title: 'Talk', at: ahead }) })

    expect(form.scheduled()).toBe(`${ahead.slice(0, 10)} ${ahead.slice(11, 16)} UTC`)
    form.drafts.set(form.entry, 'at', undefined)
    expect(form.scheduled()).toBeUndefined()
    form.drafts.set(form.entry, 'at', '2020-01-01T00:00:00.000Z')
    expect(form.scheduled()).toBeUndefined()
  })

  test('leaves a draft a draft, and a collection with no publishAt alone', () => {
    const drafted = createEntryForm({ prefix: '/admin', collection: talks, entry: scheduledEntry({ title: 'Talk', at: ahead, draft: true }) })
    const plain = createEntryForm({ prefix: '/admin', collection: { ...talks, publishField: undefined }, entry: scheduledEntry({ title: 'Talk', at: ahead }) })

    expect([drafted.isDraft(), drafted.scheduled(), plain.scheduled()]).toEqual([true, undefined, undefined])
  })
})

describe('an ending entry\'s form', () => {
  const offers: ScreenCollection = { name: 'offers', kind: 'folder', localized: false, components: [], unpublishField: 'ends', draftField: 'draft', schema: { properties: { title: { type: 'string' }, ends: { type: 'string', format: 'date-time' }, draft: { type: 'boolean' } } } }
  const ahead = new Date(Date.now() + 86_400_000).toISOString()
  const ending = (data: Record<string, unknown>) => ({ ...entry('offer', 'Offer'), data }) as StoredEntry

  test('says when the entry comes down while its date is ahead, following the edits, then that it ended once it passes', () => {
    const form = createEntryForm({ prefix: '/admin', collection: offers, entry: ending({ title: 'Offer', ends: ahead }) })

    expect([form.ends(), form.ended()]).toEqual([`${ahead.slice(0, 10)} ${ahead.slice(11, 16)} UTC`, false])
    form.drafts.set(form.entry, 'ends', '2020-01-01T00:00:00.000Z')
    expect([form.ends(), form.ended()]).toEqual([undefined, true])
    form.drafts.set(form.entry, 'ends', undefined)
    expect([form.ends(), form.ended()]).toEqual([undefined, false])
  })

  test('leaves a draft and a collection with no unpublishAt alone', () => {
    const drafted = createEntryForm({ prefix: '/admin', collection: offers, entry: ending({ title: 'Offer', ends: ahead, draft: true }) })
    const plain = createEntryForm({ prefix: '/admin', collection: { ...offers, unpublishField: undefined }, entry: ending({ title: 'Offer', ends: ahead }) })

    expect([drafted.ends(), drafted.ended(), plain.ends(), plain.ended()]).toEqual([undefined, false, undefined, false])
  })
})

describe('createEntryForm', () => {
  test.each(['/', '/admin', '/studio/cms/admin'])('carries the prefix %s the parts write their links from', (prefix) => {
    const form = createEntryForm({ prefix, collection: posts, entry: entry('notes/a b@c', 'Title') })

    expect(form.prefix).toBe(prefix)
    expect(form.entry).toEqual({ collection: 'posts', slug: 'notes/a b@c', locale: undefined })
    expect(onPagePath(form.prefix, form.stored!.url!)).toBe(screenPath(prefix, '/page?path=%2Fblog%2Fnotes%2Fa%20b%40c'))
  })

  test('names a saved entry by its title with its slug and locale beneath, a new one New entry', () => {
    const saved = createEntryForm({ prefix: '/admin', collection: posts, entry: entry('a b@c', 'Title', 'fr') })
    const created = createEntryForm({ prefix: '/admin', collection: posts, locale: 'fr' })

    expect([saved.name, saved.subtitle]).toEqual(['Title', 'a b@c (fr)'])
    expect([created.name, created.subtitle, created.stored, created.entry.locale]).toEqual(['New entry', undefined, undefined, 'fr'])
  })

  test('reads an entry given as a function each time, so a screen refreshed in place follows it', () => {
    let current = entry('hello', 'Hello')
    const form = createEntryForm({ prefix: '/admin', collection: posts, entry: () => current })

    expect([form.name, form.subtitle, form.stored?.data]).toEqual(['Hello', 'hello', { title: 'Hello' }])

    current = { ...entry('hello', 'Hello again'), problem: 'does not parse' }
    expect([form.name, form.subtitle, form.stored?.data, form.problem]).toEqual(['Hello again', 'hello', { title: 'Hello again' }, 'does not parse'])
  })
})
