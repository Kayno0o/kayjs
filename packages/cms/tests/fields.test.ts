import type { Field } from '../src/fields'
import { describe, expect, it } from 'bun:test'
import { s } from 'kay'
import { emptyValue, fieldsOf, humanize, isCompact, itemAt, itemTitle } from '../src/fields'

describe('fieldsOf', () => {
  it('turns each property into a field, in order, with its label and whether it is required', () => {
    const fields = fieldsOf({
      type: 'object',
      required: ['title', 'publishedAt'],
      properties: {
        title: { type: 'string' },
        publishedAt: { type: 'string', format: 'date' },
        summary: { type: 'string', maxLength: 300, description: 'Shown in lists' },
        featured: { type: 'boolean' },
        price: { type: 'number' },
        stock: { type: 'integer' },
      },
    })

    expect(fields).toEqual([
      { key: 'title', label: 'Title', required: true, hint: undefined, kind: 'text' },
      { key: 'publishedAt', label: 'Published at', required: true, hint: undefined, kind: 'date' },
      { key: 'summary', label: 'Summary', required: false, hint: 'Shown in lists', kind: 'textarea' },
      { key: 'featured', label: 'Featured', required: false, hint: undefined, kind: 'boolean' },
      { key: 'price', label: 'Price', required: false, hint: undefined, kind: 'number' },
      { key: 'stock', label: 'Stock', required: false, hint: undefined, kind: 'integer' },
    ])
  })

  it('counts a field with a default as optional, since it is filled in when left out', () => {
    expect(fieldsOf({ properties: { tags: { type: 'array', items: { type: 'string' }, default: [] } }, required: ['tags'] })[0]?.required).toBe(false)
  })

  it('reads the kind kay hints, a reference naming its collection', () => {
    const [cover, body, author] = fieldsOf({
      properties: {
        cover: { 'type': 'string', 'x-kay': { kind: 'image' } },
        body: { 'type': 'string', 'x-kay': { kind: 'markdown' } },
        author: { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'authors' } },
      },
    })

    expect(cover?.kind).toBe('image')
    expect(body?.kind).toBe('markdown')
    expect(author).toMatchObject({ kind: 'reference', collection: 'authors' })
  })

  it('reads a kind the app names as a custom one, in a list and a group too, and starts it unset', () => {
    const [color, palette, theme] = fieldsOf({
      properties: {
        color: { 'type': 'string', 'x-kay': { kind: 'color' } },
        palette: { type: 'array', items: { 'type': 'string', 'x-kay': { kind: 'color' } } },
        theme: { type: 'object', properties: { accent: { 'type': 'string', 'x-kay': { kind: 'color' } } } },
      },
    })

    expect(color).toMatchObject({ kind: 'custom', name: 'color' })
    expect(palette).toMatchObject({ kind: 'list', item: { kind: 'custom', name: 'color' } })
    expect(theme).toMatchObject({ kind: 'group', fields: [{ kind: 'custom', name: 'color' }] })
    expect(emptyValue(color!)).toBeUndefined()
  })

  it('reads each kind customField refuses as a built-in one, never a custom one', () => {
    for (const kind of ['text', 'textarea', 'markdown', 'number', 'integer', 'boolean', 'date', 'datetime', 'image', 'file', 'json', 'reference'])
      expect(fieldsOf({ properties: { pick: { 'type': 'string', 'x-kay': { kind } } } })[0]?.kind).not.toBe('custom')
  })

  it('treats a hint naming a kind that needs more than the hint as the app\'s own', () => {
    expect(fieldsOf({ properties: { pick: { 'type': 'string', 'x-kay': { kind: 'select' } } } })[0]).toMatchObject({ kind: 'custom', name: 'select' })
  })

  it('picks a union of literals or an enum from a list, keeping numbers as numbers', () => {
    const [status, size] = fieldsOf({
      properties: {
        status: { anyOf: [{ const: 'draft', type: 'string' }, { const: 'live', type: 'string' }] },
        size: { enum: [1, 2] },
      },
    })

    expect(status).toMatchObject({ kind: 'select', options: [{ value: 'draft', raw: 'draft' }, { value: 'live', raw: 'live' }] })
    expect(size).toMatchObject({ kind: 'select', options: [{ value: '1', raw: 1 }, { value: '2', raw: 2 }] })
  })

  it('labels a literal\'s option with its title, the value staying what is stored', () => {
    const [status] = fieldsOf({
      properties: {
        status: { anyOf: [{ const: 'new', type: 'string', title: 'Nouveau' }, { const: 'sold', type: 'string' }] },
      },
    })

    expect(status).toMatchObject({ kind: 'select', options: [{ value: 'new', label: 'Nouveau', raw: 'new' }, { value: 'sold', label: 'sold', raw: 'sold' }] })
  })

  it('edits the coercing numbers, booleans and dates of kay\'s own `s` as their plain kind', () => {
    const schema = JSON.parse(JSON.stringify(s.Object({
      price: s.Integer(),
      titled: s.Integer({ title: 'Price', description: 'In cents', minimum: 1, default: 100 }),
      optional: s.Optional(s.Integer()),
      nullable: s.Nullable(s.Integer()),
      ratio: s.Numeric(),
      flag: s.BooleanString(),
      day: s.Date(),
      optionalDay: s.Optional(s.Date()),
      nullableDay: s.Nullable(s.Date()),
      prices: s.Array(s.Integer()),
    })))
    const [price, titled, optional, nullable, ratio, flag, day, optionalDay, nullableDay, prices] = fieldsOf(schema)

    expect(price).toMatchObject({ kind: 'integer', required: true })
    expect(titled).toMatchObject({ kind: 'integer', label: 'Price', hint: 'In cents', required: false })
    expect(optional).toMatchObject({ kind: 'integer', required: false })
    expect(nullable).toMatchObject({ kind: 'integer', required: false })
    expect(ratio?.kind).toBe('number')
    expect(flag?.kind).toBe('boolean')
    expect(day?.kind).toBe('date')
    expect(optionalDay?.kind).toBe('date')
    expect(nullableDay).toMatchObject({ kind: 'date', required: false })
    expect(prices).toMatchObject({ kind: 'list', item: { kind: 'integer' } })
  })

  it('keeps a union of other shapes as JSON', () => {
    expect(fieldsOf({ properties: { mixed: { anyOf: [{ type: 'string', format: 'integer' }, { type: 'string' }] } } })[0]?.kind).toBe('json')
  })

  it('makes a nullable field optional and edits it as its inner type', () => {
    const [subtitle] = fieldsOf({
      required: ['subtitle'],
      properties: { subtitle: { title: 'Sub', anyOf: [{ type: 'string' }, { type: 'null' }] } },
    })

    expect(subtitle).toMatchObject({ kind: 'text', label: 'Sub', required: false })
  })

  it('nests lists and groups', () => {
    const [sections] = fieldsOf({
      properties: {
        sections: { type: 'array', items: { type: 'object', required: ['heading'], properties: { heading: { type: 'string' }, image: { 'type': 'string', 'x-kay': { kind: 'image' } } } } },
      },
    })

    expect(sections).toMatchObject({
      kind: 'list',
      item: { kind: 'group', fields: [{ key: 'heading', kind: 'text', required: true }, { key: 'image', kind: 'image', required: false }] },
    })
  })

  it('falls back to raw JSON for a shape it has no control for', () => {
    expect(fieldsOf({ properties: { meta: {} } })[0]?.kind).toBe('json')
  })
})

describe('humanize', () => {
  it('spells camelCase, snake_case and kebab-case keys as a label', () => {
    expect(humanize('publishedAt')).toBe('Published at')
    expect(humanize('cover_image')).toBe('Cover image')
    expect(humanize('meta-title')).toBe('Meta title')
    expect(humanize('seoURL')).toBe('Seo URL')
    expect(humanize('heroImage2x')).toBe('Hero image2x')
  })
})

describe('emptyValue', () => {
  it('starts a new list item blank, a group with each of its fields blank', () => {
    const [item] = fieldsOf({
      properties: {
        row: { type: 'object', required: ['size'], properties: { label: { type: 'string' }, on: { type: 'boolean' }, count: { type: 'number' }, size: { enum: ['s', 'm'] }, tags: { type: 'array', items: { type: 'string' } } } },
      },
    })

    expect(emptyValue(item as Field)).toEqual({ label: '', on: false, count: undefined, size: undefined, tags: [] })
  })

  it('starts a new item from the schema default, a group from its fields\' defaults, never sharing the default', () => {
    const [links, tags, rows] = fieldsOf({ properties: { links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string', minLength: 1, default: 'Link' }, kind: { enum: ['a', 'b'], default: 'b' } } } }, tags: { type: 'array', items: { type: 'string', default: 'new' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' }, default: ['x'] } } } }) as (Field & { kind: 'list' })[]

    expect(emptyValue(links!.item)).toEqual({ label: 'Link', kind: 'b' })
    expect(emptyValue(tags!.item)).toBe('new')

    const first = emptyValue(rows!.item) as string[]

    first.push('y')
    expect(emptyValue(rows!.item)).toEqual(['x'])
  })

  it('leaves a required select unpicked, as it has no default to start from', () => {
    const [mood] = fieldsOf({ required: ['mood'], properties: { mood: { enum: ['calm', 'busy'] } } })

    expect(emptyValue(mood!)).toBeUndefined()
  })
})

describe('itemAt', () => {
  it('numbers a list\'s items by their place, unless their schema titles them', () => {
    const [tags, links] = fieldsOf({ properties: { tags: { type: 'array', items: { type: 'string' } }, links: { type: 'array', items: { type: 'string', title: 'Link' } } } }) as (Field & { kind: 'list' })[]

    expect([itemAt(tags!, 0), itemAt(tags!, 1)].map(item => [item.key, item.label])).toEqual([[0, 'Item 1'], [1, 'Item 2']])
    expect(itemAt(links!, 1).label).toBe('Link')
  })
})

describe('list bounds', () => {
  it('reads minItems and maxItems, ignoring what is not a count', () => {
    const [bounded, loose, odd] = fieldsOf({ properties: { a: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } }, b: { type: 'array', items: { type: 'string' } }, c: { type: 'array', minItems: -1, maxItems: 1.5, items: { type: 'string' } } } })

    expect(bounded).toMatchObject({ kind: 'list', minItems: 1, maxItems: 3 })
    expect(loose).toMatchObject({ kind: 'list', minItems: undefined, maxItems: undefined })
    expect(odd).toMatchObject({ kind: 'list', minItems: undefined, maxItems: undefined })
  })
})

describe('itemTitle and isCompact', () => {
  const [people, tags, flags] = fieldsOf({ properties: { people: { type: 'array', items: { type: 'object', properties: { age: { type: 'integer' }, name: { type: 'string' }, bio: { type: 'string' } } } }, tags: { type: 'array', items: { type: 'string' } }, flags: { type: 'array', items: { type: 'boolean' } } } }) as (Field & { kind: 'list' })[]

  it('heads a group by its first filled text, else by its place', () => {
    expect(itemTitle(people!, { name: ' Ada ', bio: 'x' }, 2)).toBe('Ada')
    expect(itemTitle(people!, { name: '', bio: 'x' }, 2)).toBe('x')
    expect(itemTitle(people!, { name: '  ', bio: '' }, 2)).toBe('Item 3')
    expect(itemTitle(people!, undefined, 0)).toBe('Item 1')
    expect(itemTitle(tags!, 'a', 1)).toBe('Item 2')
  })

  it('shows single controls as compact rows and the others folded under a head', () => {
    expect([people, tags, flags].map(list => isCompact(list!))).toEqual([false, true, true])
  })
})

describe('image fields', () => {
  const image = (hint: object) => ({ 'type': 'string', 'x-kay': { kind: 'image', ...hint } })

  it('carry what they ask of an upload', () => {
    const [photo, doc] = fieldsOf({ properties: { photo: image({ accept: ['image/png'], maxSize: 2048, minWidth: 800 }), doc: { 'type': 'string', 'x-kay': { kind: 'file', accept: ['application/pdf'] } } } })

    expect(photo).toMatchObject({ kind: 'image', upload: { accept: ['image/png'], maxSize: 2048, minWidth: 800 } })
    expect(doc).toMatchObject({ kind: 'file', upload: { accept: ['application/pdf'] } })
  })

  it('take the fields they name for alt, width and height, which the form no longer shows beside them', () => {
    const fields = fieldsOf({
      required: ['photoAlt'],
      properties: { title: { type: 'string' }, photo: image({ alt: 'photoAlt', width: 'photoWidth', height: 'photoHeight' }), photoAlt: { type: 'string' }, photoWidth: { type: 'integer' }, photoHeight: { type: 'integer' }, caption: { type: 'string' } },
    })

    expect(fields.map(field => field.key)).toEqual(['title', 'photo', 'caption'])
    expect(fields[1]).toMatchObject({ kind: 'image', upload: { alt: { key: 'photoAlt', required: true }, width: { key: 'photoWidth', kind: 'integer' }, height: { key: 'photoHeight' } } })
  })

  it('ignore a name that is no field beside them, and pair inside a group', () => {
    const [lone] = fieldsOf({ properties: { photo: image({ alt: 'missing' }) } })

    expect(lone).toMatchObject({ kind: 'image', upload: {} })
    expect((lone as Field & { kind: 'image' }).upload?.alt).toBeUndefined()

    const [group] = fieldsOf({ properties: { hero: { type: 'object', properties: { src: image({ alt: 'alt' }), alt: { type: 'string' } } } } })

    expect(group).toMatchObject({ kind: 'group', fields: [{ key: 'src', upload: { alt: { key: 'alt' } } }] })
    expect((group as Field & { kind: 'group' }).fields).toHaveLength(1)
  })

  it('pair with nothing in a list, whose items have no siblings', () => {
    const [list] = fieldsOf({ properties: { gallery: { type: 'array', items: image({ alt: 'alt', minWidth: 10 }) } } })

    expect(list).toMatchObject({ kind: 'list', item: { kind: 'image', upload: { minWidth: 10 } } })
    expect((list as Field & { kind: 'list' }).item).not.toHaveProperty('upload.alt')
  })
})
