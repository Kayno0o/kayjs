import { beforeEach, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection, unique } from 'kay/content'
import { registerCollections, registerEditSite } from '../../../src/content/edit'
import { sqliteLoader } from '../src/loaders/sqlite'
import { configure } from '../src/settings'
import { duplicateEntry, entryOf, saveEntry } from '../src/store'
import { withFreeUniques } from '../src/unique'

let count = 0

beforeEach(() => {
  const table = (name: string) => sqliteLoader({ name, database: ':memory:', table: `${name}_${++count}` })

  registerEditSite({ urls: async () => undefined, locales: ['en', 'fr'], defaultLocale: 'en' })
  registerCollections([
    ['things', collection(table('things'), { schema: s.Object({ title: s.String(), code: unique(s.String()) }) })],
    ['counted', collection(table('counted'), { schema: s.Object({ title: s.String(), rank: s.Optional(unique(s.Number())) }) })],
    ['short', collection(table('short'), { schema: s.Object({ title: s.String(), code: s.Optional(unique(s.String({ maxLength: 4 }))) }) })],
    ['mails', collection(table('mails'), { schema: s.Object({ title: s.String(), mail: s.Optional(unique(s.String({ format: 'email' }))) }) })],
    ['strict', collection(table('strict'), { schema: s.Object({ title: s.String(), code: unique(s.String({ maxLength: 4 })) }) })],
    ['langs', collection(table('langs'), { schema: s.Object({ title: s.String(), code: unique(s.String()) }), localized: true })],
    ['required', collection(table('required'), { schema: s.Object({ title: s.String(), rank: unique(s.Number()) }) })],
  ])
  configure({})
})

describe('duplicateEntry on a collection with a unique field', () => {
  test('suffixes a text value, like the slug, until it is free', async () => {
    await saveEntry({ collection: 'things', slug: 'a', data: { title: 'A', code: 'X1' } }, { create: true })

    const first = await duplicateEntry({ collection: 'things', slug: 'a' })
    const second = await duplicateEntry({ collection: 'things', slug: 'a' })

    expect(first).toMatchObject({ ok: true, slug: 'a-copy' })
    expect(second).toMatchObject({ ok: true, slug: 'a-copy-2' })
    expect((await entryOf({ collection: 'things', slug: 'a-copy' }))?.data?.code).toBe('X1-copy')
    expect((await entryOf({ collection: 'things', slug: 'a-copy-2' }))?.data?.code).toBe('X1-copy-2')
  })

  test('clears a value that is not text', async () => {
    await saveEntry({ collection: 'counted', slug: 'a', data: { title: 'A', rank: 3 } }, { create: true })

    expect(await duplicateEntry({ collection: 'counted', slug: 'a' })).toMatchObject({ ok: true })
    expect((await entryOf({ collection: 'counted', slug: 'a-copy' }))?.data).toEqual({ title: 'A' })
  })

  test('clears a text value its suffix would break, and refuses a required one naming it', async () => {
    await saveEntry({ collection: 'short', slug: 'a', data: { title: 'A', code: 'ab12' } }, { create: true })
    await saveEntry({ collection: 'mails', slug: 'a', data: { title: 'A', mail: 'a@b.fr' } }, { create: true })
    await saveEntry({ collection: 'strict', slug: 'a', data: { title: 'A', code: 'ab12' } }, { create: true })

    expect(await duplicateEntry({ collection: 'short', slug: 'a' })).toMatchObject({ ok: true })
    expect((await entryOf({ collection: 'short', slug: 'a-copy' }))?.data).toEqual({ title: 'A' })
    expect(await duplicateEntry({ collection: 'mails', slug: 'a' })).toMatchObject({ ok: true })
    expect((await entryOf({ collection: 'mails', slug: 'a-copy' }))?.data).toEqual({ title: 'A' })

    const out = await duplicateEntry({ collection: 'strict', slug: 'a' })

    expect(!out.ok && out.error.message).toMatch(/^code: /)
  })

  test('counts the values of the copy\'s own locale, as the unique check does', async () => {
    await saveEntry({ collection: 'langs', slug: 'a', locale: 'en', data: { title: 'A', code: 'X1' } }, { create: true })
    await saveEntry({ collection: 'langs', slug: 'b', locale: 'fr', data: { title: 'B', code: 'X1-copy' } }, { create: true })

    expect(await duplicateEntry({ collection: 'langs', slug: 'a', locale: 'en' })).toMatchObject({ ok: true })
    expect((await entryOf({ collection: 'langs', slug: 'a-copy', locale: 'en' }))?.data?.code).toBe('X1-copy')
  })

  test('names the field when a copy is refused', async () => {
    await saveEntry({ collection: 'required', slug: 'a', data: { title: 'A', rank: 3 } }, { create: true })

    const out = await duplicateEntry({ collection: 'required', slug: 'a' })

    expect(out.ok).toBe(false)
    expect(!out.ok && out.error.message).toMatch(/^rank: /)
  })
})

describe('withFreeUniques', () => {
  const copy = (properties: Record<string, unknown>, data: Record<string, unknown>) => withFreeUniques({ properties } as never, data, [], value => `${value}-copy`)

  test('looks under a union, as a nullable field is, for what a suffix would break', () => {
    const limited = { 'anyOf': [{ type: 'string', maxLength: 4 }, { type: 'null' }], 'x-kay-unique': true }
    const formatted = { 'oneOf': [{ type: 'string', format: 'email' }, { type: 'null' }], 'x-kay-unique': true }
    const open = { 'anyOf': [{ type: 'string' }, { type: 'null' }], 'x-kay-unique': true }

    expect(copy({ code: limited }, { code: 'ab12' })).toEqual({})
    expect(copy({ code: formatted }, { code: 'a@b.fr' })).toEqual({})
    expect(copy({ code: open }, { code: 'ab12' })).toEqual({ code: 'ab12-copy' })
  })
})
