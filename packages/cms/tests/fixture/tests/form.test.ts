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
