import type { JsonSchema } from '../src/kay/contract'
import { describe, expect, test } from 'bun:test'
import { fieldsOf } from '../src/fields'
import { hintProblems, missingKindLines, missingKinds } from '../src/kinds'

const custom = (kind: string) => ({ 'type': 'string', 'x-kay': { kind } })
const posts = { name: 'posts', schema: { type: 'object', properties: { color: custom('color'), tags: { type: 'array', items: custom('mood') }, theme: { type: 'object', properties: { accent: custom('color') } }, cover: { 'type': 'string', 'x-kay': { kind: 'image' } } } } }
const pages = { name: 'pages', schema: { type: 'object', properties: { color: custom('color') } } }

test('lists the custom kinds with no component, in lists and groups too, each with the collections naming it', () => {
  expect([...missingKinds([posts, pages], new Set(['mood']))]).toEqual([['color', ['posts', 'pages']]])
  expect([...missingKinds([posts], new Set(['color', 'mood']))]).toEqual([])
})

test('reads the components off the project\'s src/cms/fields folder', () => {
  // The fixture app has a color component and none for mood.
  const root = `${import.meta.dir}/fixture`
  const lines = missingKindLines(root, [{ name: 'products', schema: { type: 'object', properties: { color: custom('color'), mood: custom('mood') } } }])

  expect(lines).toEqual(['no editor for the mood kind that products uses: add src/cms/fields/mood.kay, until then it is edited as JSON'])
})

test('reports nothing for a root without src, as an executable has', () => {
  expect(missingKindLines(`${import.meta.dir}/fixture/src/cms`, [posts])).toEqual([])
})

test('finds a custom kind inside a block of a blocks list', () => {
  const item = (type: string, field: JsonSchema) => ({ type: 'object', properties: { type: { type: 'string', const: type }, field }, required: ['type'] })
  const page = { name: 'pages', schema: { type: 'object', properties: { sections: { 'type': 'array', 'x-kay': { kind: 'blocks' }, 'items': { anyOf: [item('hero', { type: 'string' }), item('text', custom('mood'))] } } } } }

  expect([...missingKinds([page], new Set())]).toEqual([['mood', ['pages']]])
})

describe('a string x-kay, as apps wrote it before fieldInput', () => {
  const legacy = (hint: unknown, extra: Record<string, unknown> = {}) => ({ 'type': 'string', ...extra, 'x-kay': hint }) as JsonSchema
  const schemaOf = (field: JsonSchema): JsonSchema => ({ type: 'object', properties: { field } })

  test('is read as the kind it names, a built-in one or the app\'s own', () => {
    expect(fieldsOf(schemaOf(legacy('text', { format: 'email' })))[0]).toMatchObject({ kind: 'text', inputType: 'email' })
    expect(fieldsOf(schemaOf(legacy('markdown')))[0]).toMatchObject({ kind: 'markdown' })
    expect(fieldsOf(schemaOf(legacy('mood')))[0]).toMatchObject({ kind: 'custom', name: 'mood' })
    expect(fieldsOf(schemaOf({ type: 'array', items: legacy('textarea') }))[0]).toMatchObject({ kind: 'list', item: { kind: 'textarea' } })
    expect(fieldsOf(schemaOf({ type: 'object', properties: { inner: legacy('text') } }))[0]).toMatchObject({ kind: 'group', fields: [{ kind: 'text' }] })
  })

  test('never makes a custom kind named undefined, whatever the hint is', () => {
    for (const hint of [true, {}, 3, null, { kind: 3 }]) {
      const field = fieldsOf(schemaOf(legacy(hint)))[0]!

      expect(field.kind).toBe('text')
      expect(missingKinds([{ name: 'posts', schema: schemaOf(legacy(hint)) }], new Set())).toEqual(new Map())
    }
  })

  test('is a missing component when it names a kind the app has none for', () => {
    expect([...missingKinds([{ name: 'posts', schema: schemaOf(legacy('mood')) }], new Set())]).toEqual([['mood', ['posts']]])
  })

  test('is refused with the collection, the field\'s path and fieldInput when it is neither a string nor an object with a kind', () => {
    const schema = (hint: unknown): JsonSchema => ({ type: 'object', properties: { title: legacy(hint), tags: { type: 'array', items: legacy(hint) }, meta: { type: 'object', properties: { note: legacy(hint) } }, ok: legacy('text') } })

    for (const hint of [true, {}]) {
      expect(hintProblems([{ name: 'posts', schema: schema(hint) }])).toEqual([
        'posts: title has an `x-kay` that is neither a kind name nor `{ kind }`: set it with `fieldInput`, or remove it',
        'posts: tags[] has an `x-kay` that is neither a kind name nor `{ kind }`: set it with `fieldInput`, or remove it',
        'posts: meta.note has an `x-kay` that is neither a kind name nor `{ kind }`: set it with `fieldInput`, or remove it',
      ])
    }

    expect(hintProblems([{ name: 'posts', schema: schema('text') }])).toEqual([])
  })
})
