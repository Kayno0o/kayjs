import { beforeEach, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection, unique } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { sqliteLoader } from '../src/loaders/sqlite'
import { configure } from '../src/settings'
import { duplicateEntry, entryOf, saveEntry } from '../src/store'

let count = 0

beforeEach(() => {
  const table = (name: string) => sqliteLoader({ name, database: ':memory:', table: `${name}_${++count}` })

  registerCollections([
    ['things', collection(table('things'), { schema: s.Object({ title: s.String(), code: unique(s.String()) }) })],
    ['counted', collection(table('counted'), { schema: s.Object({ title: s.String(), rank: s.Optional(unique(s.Number())) }) })],
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

  test('names the field when a copy is refused', async () => {
    await saveEntry({ collection: 'required', slug: 'a', data: { title: 'A', rank: 3 } }, { create: true })

    const out = await duplicateEntry({ collection: 'required', slug: 'a' })

    expect(out.ok).toBe(false)
    expect(!out.ok && out.error.message).toMatch(/^rank: /)
  })
})
