import { describe, expect, mock, test } from 'bun:test'

const people = { name: 'people', kind: 'folder', localized: false, components: [], schema: { properties: { name: { type: 'string' } } } }
const posts = { name: 'posts', kind: 'folder', localized: false, components: [], title: 'Posts', schema: { properties: { title: { type: 'string' }, author: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'people' } }, editors: { type: 'array', items: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'people' } } }, credit: { type: 'object', properties: { by: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'people' } } } }, tag: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'tags' } } } } }
const friends = { name: 'friends', kind: 'folder', localized: false, components: [], schema: { properties: { name: { type: 'string' }, friend: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'friends' } } } } }
const broken = { name: 'broken', kind: 'folder', localized: false, components: [], schema: { properties: { who: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'people' } } } } }

const notes = { name: 'notes', kind: 'folder', localized: true, components: [], title: 'Notes', schema: { properties: { title: { type: 'string' }, place: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'places' } } } } }

const held: Record<string, { slug: string, locale?: string, data: Record<string, unknown> }[]> = {
  posts: [
    { slug: 'one', data: { title: 'One', author: 'ada' } },
    { slug: 'two', data: { title: 'Two', editors: ['bob', 'ada'] } },
    { slug: 'three', data: { title: 'Three', credit: { by: 'bob' }, tag: 'ada' } },
    { slug: 'four', data: { title: 'Four', author: 'cy' } },
  ],
  people: [{ slug: 'ada', data: { name: 'Ada' } }, { slug: 'bob', data: { name: 'Bob' } }],
  notes: [{ slug: 'hello', locale: 'fr', data: { title: 'Bonjour', place: 'paris' } }, { slug: 'hello', locale: 'en', data: { title: 'Hello', place: 'paris' } }],
  friends: [{ slug: 'ada', data: { name: 'Ada', friend: 'ada' } }, { slug: 'bob', data: { name: 'Bob', friend: 'ada' } }],
}

let listing = true

void mock.module('../src/kay/content', () => ({
  collections: async () => {
    if (!listing)
      throw new Error('database down')

    return [people, posts, friends, broken, notes]
  },
  entries: async (name: string, filter?: { slug?: string }) => {
    if (name === 'broken')
      throw new Error('database down')

    return (held[name] ?? []).filter(entry => filter?.slug === undefined || entry.slug === filter.slug)
  },
}))

const { referrersOf, referrersWith, missingReferences, UnreadReferrersError } = await import('../src/references')

describe('referrersOf', () => {
  test('names the entries pointing at a slug through a field, a list or a group, in any collection', async () => {
    const found = await referrersOf('people', ['ada', 'bob', 'dan'])

    expect(found.get('ada')).toEqual(['Posts: One', 'Posts: Two'])
    expect(found.get('bob')).toEqual(['Posts: Two', 'Posts: Three'])
    expect(found.has('dan')).toBe(false)
  })

  test('reads a reference by the collection it names, not by the slug alone', async () => {
    expect([...(await referrersOf('people', ['ada'])).keys()]).toEqual(['ada'])
    expect((await referrersOf('tags', ['ada'])).get('ada')).toEqual(['Posts: Three'])
  })

  test('labels a localized referrer with its locale', async () => {
    expect((await referrersOf('places', ['paris'])).get('paris')).toEqual(['Notes (fr): Bonjour', 'Notes (en): Hello'])
  })

  test('leaves out an entry pointing at itself and a collection that fails to read', async () => {
    const found = await referrersOf('friends', ['ada', 'bob'])

    expect(found.get('ada')).toEqual(['Friends: Bob'])
    expect(found.has('bob')).toBe(false)
  })

  test('reads nothing for no slug', async () => {
    expect((await referrersOf('people', [])).size).toBe(0)
  })
})

describe('referrersWith, strict', () => {
  test('names the collection that fails to read, and none when the list of collections itself fails', async () => {
    await expect(referrersWith('people', ['ada'], { strict: true })).rejects.toMatchObject({ names: ['Broken'] })
    listing = false

    try {
      await expect(referrersWith('people', ['ada'], { strict: true })).rejects.toBeInstanceOf(UnreadReferrersError)
      await expect(referrersWith('people', ['ada'], { strict: true })).rejects.toMatchObject({ names: [] })
      expect((await referrersWith('people', ['ada'])).size).toBe(0)
    }
    finally {
      listing = true
    }
  })
})

describe('missingReferences', () => {
  const draft = (data: Record<string, unknown>, slug = 'new') => ({ collection: 'posts', slug, data })
  const nothingStored = async () => undefined
  const post = posts as never

  test('names a reference to an entry the target lacks, through a field, a list or a group, with its path', async () => {
    const issues = await missingReferences(post, draft({ author: 'ghost', editors: ['bob', 'ghost'], credit: { by: 'nobody' } }), nothingStored)

    expect(issues.map(issue => [issue.path, issue.message])).toEqual([['author', 'No entry ghost in people'], ['editors.1', 'No entry ghost in people'], ['credit.by', 'No entry nobody in people']])
  })

  test('lets a reference to an entry that exists, an empty one and a collection that fails to read through', async () => {
    expect(await missingReferences(post, draft({ author: 'ada', editors: [] }), nothingStored)).toEqual([])
    const fragile = { ...broken, name: 'fragile', schema: { properties: { who: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'broken' } } } } }

    expect(await missingReferences(fragile as never, { collection: 'fragile', slug: 'f', data: { who: 'ghost' } }, nothingStored)).toEqual([])
    expect(await missingReferences(post, draft({ author: '' }), nothingStored)).toEqual([])
  })

  test('lets a reference the stored entry held already, so publishing never stops on an old one', async () => {
    expect(await missingReferences(post, draft({ author: 'ghost' }, 'one'), async () => ({ author: 'ghost' }))).toEqual([])
    expect((await missingReferences(post, draft({ author: 'other' }, 'one'), async () => ({ author: 'ghost' }))).map(issue => issue.path)).toEqual(['author'])
  })

  test('lets an entry of a collection refer to itself', async () => {
    expect(await missingReferences(friends as never, { collection: 'friends', slug: 'cy', data: { friend: 'cy' } }, nothingStored)).toEqual([])
    expect(await missingReferences(friends as never, { collection: 'friends', slug: 'cy', data: { friend: 'dan' } }, nothingStored)).toHaveLength(1)
  })
})
