import { describe, expect, mock, test } from 'bun:test'

const people = { name: 'people', kind: 'folder', localized: false, components: [], schema: { properties: { name: { type: 'string' } } } }
const posts = { name: 'posts', kind: 'folder', localized: false, components: [], title: 'Posts', schema: { properties: { title: { type: 'string' }, author: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'people' } }, editors: { type: 'array', items: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'people' } } }, credit: { type: 'object', properties: { by: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'people' } } } }, tag: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'tags' } } } } }
const friends = { name: 'friends', kind: 'folder', localized: false, components: [], schema: { properties: { name: { type: 'string' }, friend: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'friends' } } } } }
const broken = { name: 'broken', kind: 'folder', localized: false, components: [], schema: { properties: { who: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'people' } } } } }

const held: Record<string, { slug: string, data: Record<string, unknown> }[]> = {
  posts: [
    { slug: 'one', data: { title: 'One', author: 'ada' } },
    { slug: 'two', data: { title: 'Two', editors: ['bob', 'ada'] } },
    { slug: 'three', data: { title: 'Three', credit: { by: 'bob' }, tag: 'ada' } },
    { slug: 'four', data: { title: 'Four', author: 'cy' } },
  ],
  friends: [{ slug: 'ada', data: { name: 'Ada', friend: 'ada' } }, { slug: 'bob', data: { name: 'Bob', friend: 'ada' } }],
}

void mock.module('../src/kay/content', () => ({
  collections: async () => [people, posts, friends, broken],
  entries: async (name: string) => {
    if (name === 'broken')
      throw new Error('database down')

    return held[name] ?? []
  },
}))

const { referrersOf } = await import('../src/references')

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

  test('leaves out an entry pointing at itself and a collection that fails to read', async () => {
    const found = await referrersOf('friends', ['ada', 'bob'])

    expect(found.get('ada')).toEqual(['Friends: Bob'])
    expect(found.has('bob')).toBe(false)
  })

  test('reads nothing for no slug', async () => {
    expect((await referrersOf('people', [])).size).toBe(0)
  })
})
