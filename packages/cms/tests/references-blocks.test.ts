import { expect, mock, test } from 'bun:test'

const variant = (type: string, field: object) => ({ type: 'object', properties: { type: { type: 'string', const: type }, ...field }, required: ['type'] })
const ref = (collection: string) => ({ 'type': 'string', 'x-kay': { kind: 'reference', collection } })
const landing = { name: 'landing', kind: 'folder', localized: false, components: [], title: 'Landing', schema: { properties: { title: { type: 'string' }, sections: { 'type': 'array', 'x-kay': { kind: 'blocks' }, 'items': { anyOf: [variant('team', { member: ref('people') }), variant('text', { body: { type: 'string' } })] } } } } }
const people = { name: 'people', kind: 'folder', localized: false, components: [], schema: { properties: { name: { type: 'string' } } } }

void mock.module('../src/kay/content', () => ({
  collections: async () => [landing, people],
  entries: async (name: string, filter?: { slug?: string }) => name === 'landing'
    ? [{ slug: 'home', data: { title: 'Home', sections: [{ type: 'text', body: 'x' }, { type: 'team', member: 'ada' }] } }]
    : [{ slug: 'ada', data: { name: 'Ada' } }].filter(entry => filter?.slug === undefined || entry.slug === filter.slug),
}))

const { referrersOf, missingReferences } = await import('../src/references')

test('names the entries pointing at a slug from a block, and a reference to a missing entry in a block with its path', async () => {
  expect((await referrersOf('people', ['ada'])).get('ada')).toEqual(['Landing: Home'])

  const issues = await missingReferences(landing as never, { collection: 'landing', slug: 'home', data: { sections: [{ type: 'text', body: 'x' }, { type: 'team', member: 'ghost' }, { type: 'video', member: 'ghost' }] } }, async () => undefined)

  expect(issues.map(issue => issue.path)).toEqual(['sections.1.member'])
})
