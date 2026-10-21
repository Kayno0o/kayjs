import type { Field } from '../src/fields'
import type { JsonSchema } from '../src/kay/contract'
import { describe, expect, it } from 'bun:test'
import { s } from 'kay'
import { checkField, emptyValue, fieldsOf, htmlPattern, humanize, isCompact, itemAt, itemTitle, pairedFields } from '../src/fields'

describe('how a field is entered', () => {
  const one = (property: Record<string, unknown>, required = false) => fieldsOf({ type: 'object', required: required ? ['field'] : [], properties: { field: property as JsonSchema } })[0]!

  it('carries a placeholder, a prefix and a suffix, a price being a number with its unit', () => {
    expect(one({ 'type': 'number', 'minimum': 0, 'maximum': 9999, 'x-kay-input': { suffix: '€', placeholder: '600' } })).toMatchObject({ kind: 'number', suffix: '€', placeholder: '600', limits: { minimum: 0, maximum: 9999 } })
  })

  it('reads the options through a nullable or optional wrapper', () => {
    expect(one({ anyOf: [{ 'type': 'string', 'x-kay-input': { placeholder: 'Name' } }, { type: 'null' }] })).toMatchObject({ kind: 'text', placeholder: 'Name' })
    expect(one({ 'anyOf': [{ type: 'string' }, { type: 'null' }], 'x-kay-input': { placeholder: 'Name' } })).toMatchObject({ kind: 'text', placeholder: 'Name' })
  })

  it('types an email or a uri input and keeps it on one line whatever its maxLength', () => {
    expect(one({ type: 'string', format: 'email', maxLength: 254 })).toMatchObject({ kind: 'text', inputType: 'email', limits: { maxLength: 254 } })
    expect(one({ type: 'string', format: 'uri', maxLength: 2000 })).toMatchObject({ kind: 'text', inputType: 'url' })
    expect(one({ 'type': 'string', 'maxLength': 30, 'x-kay-input': { type: 'tel' } })).toMatchObject({ kind: 'text', inputType: 'tel', limits: { maxLength: 30 } })
    expect(one({ type: 'string', maxLength: 300 })).toMatchObject({ kind: 'textarea', limits: { maxLength: 300 } })
  })

  it('makes a string multi-line with the rows asked for', () => {
    expect(one({ 'type': 'string', 'x-kay-input': { rows: 6 } })).toMatchObject({ kind: 'textarea', rows: 6 })
    expect(one({ 'type': 'string', 'x-kay-input': { rows: 1 } }).kind).toBe('text')
  })

  it('labels a plain enum and a union of literals by value, a literal\'s title kept as the fallback', () => {
    const labels = { 'x-kay-input': { labels: { draft: 'Brouillon' } } }

    expect(one({ type: 'string', enum: ['draft', 'live'], ...labels })).toMatchObject({ kind: 'select', options: [{ value: 'draft', label: 'Brouillon' }, { value: 'live', label: 'live' }] })
    expect(one({ anyOf: [{ const: 'draft' }, { const: 'live', title: 'En ligne' }], ...labels })).toMatchObject({ options: [{ label: 'Brouillon' }, { label: 'En ligne' }] })
  })

  it('reads the ready-made kinds, an icon needing the set it picks from', () => {
    expect(one({ 'type': 'string', 'x-kay': { kind: 'hex-color' } }).kind).toBe('color')
    expect(one({ 'type': 'array', 'items': { type: 'string' }, 'x-kay': { kind: 'tag-list' } }).kind).toBe('tags')
    expect(one({ 'type': 'string', 'x-kay': { kind: 'icon-name', set: 'tabler' } })).toMatchObject({ kind: 'icon', set: 'tabler' })
    expect(one({ 'type': 'string', 'x-kay': { kind: 'icon-name' } })).toMatchObject({ kind: 'custom', name: 'icon-name' })
    expect(emptyValue(one({ 'type': 'array', 'items': { type: 'string' }, 'x-kay': { kind: 'tag-list' } }))).toEqual([])
  })

  it('names the sibling a field waits for', () => {
    expect(one({ 'type': 'string', 'x-kay-input': { when: 'link' } }).when).toBe('link')
  })

  it('enters a list of strings one per line, starting empty, and names the field heading a list item', () => {
    const lines = one({ 'type': 'array', 'items': { type: 'string' }, 'x-kay-input': { lines: true } })

    expect(lines.kind).toBe('lines')
    expect(emptyValue(lines)).toEqual([])
    expect(one({ 'type': 'array', 'items': { type: 'number' }, 'x-kay-input': { lines: true } }).kind).toBe('list')
    expect(one({ 'type': 'array', 'items': { type: 'string', enum: ['a', 'b'] }, 'x-kay-input': { lines: true } }).kind).toBe('list')

    const people = one({ 'type': 'array', 'x-kay-input': { titleField: 'role' }, 'items': { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' } } } }) as Field & { kind: 'list' }

    expect(itemTitle(people, { name: 'Ana', role: 'Chef' }, 0)).toBe('Chef')
    expect(itemTitle(people, { name: 'Ana', role: ' ' }, 0)).toBe('Ana')
  })

  it('leaves a field the schema says nothing of with no entering keys', () => {
    expect(Object.keys(one({ type: 'string' }))).not.toContain('placeholder')
    expect(Object.keys(one({ type: 'string' })).filter(key => ['prefix', 'suffix', 'inputType', 'rows', 'when'].includes(key))).toEqual([])
  })
})

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
      { key: 'summary', label: 'Summary', required: false, hint: 'Shown in lists', limits: { maxLength: 300 }, kind: 'textarea' },
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

  it('take a text field called alt with no hint, the first image only, and leave one a hint names or of another kind', () => {
    const [first, second] = fieldsOf({ properties: { photo: image({}), banner: image({}), alt: { type: 'string' } } })

    expect(first).toMatchObject({ key: 'photo', upload: { alt: { key: 'alt' } } })
    expect((second as Field & { kind: 'image' }).upload?.alt).toBeUndefined()
    expect(fieldsOf({ properties: { photo: image({}), alt: { type: 'string' } } }).map(field => field.key)).toEqual(['photo'])
    expect(fieldsOf({ properties: { photo: image({ alt: 'caption' }), caption: { type: 'string' }, alt: { type: 'string' } } }).map(field => field.key)).toEqual(['photo', 'alt'])
    expect(fieldsOf({ properties: { photo: image({}), alt: { type: 'integer' } } }).map(field => field.key)).toEqual(['photo', 'alt'])
  })

  it('are listed by pairedFields with the image and the role they play', () => {
    const paired = pairedFields(fieldsOf({ properties: { photo: image({ alt: 'caption', width: 'w' }), caption: { type: 'string' }, w: { type: 'integer' } } }))

    expect([...paired].map(([key, { image: owner, role }]) => [key, owner, role])).toEqual([['caption', 'photo', 'alt'], ['w', 'photo', 'width']])
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

describe('checkField', () => {
  const [name, age, note, mail, flag] = fieldsOf({
    required: ['name', 'age'],
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 5 },
      age: { type: 'integer', minimum: 18, maximum: 99 },
      note: { type: 'string' },
      mail: { type: 'string', pattern: '^[a-z]+@[a-z]+$' },
      flag: { type: 'boolean' },
    },
  }) as [Field, Field, Field, Field, Field]

  it('words a missing required value and a text out of its length or pattern as the server does', () => {
    expect(checkField(name, undefined)).toBe('Name is required')
    expect(checkField(name, 'ab')).toBe('Name needs at least 3 characters')
    expect(checkField(name, 'abcdef')).toBe('Name takes 5 characters at most')
    expect(checkField(name, 'abcd')).toBeUndefined()
    expect(checkField(mail, 'nope')).toBe('Mail is not in the expected form')
    expect(checkField(mail, 'a@b')).toBeUndefined()
  })

  it('words a figure out of its bounds, and reads the empty of a field that need not be filled as fine', () => {
    expect(checkField(age, 17)).toBe('Age must be at least 18')
    expect(checkField(age, 100)).toBe('Age must be at most 99')
    expect(checkField(age, 30)).toBeUndefined()
    expect(checkField(mail, undefined)).toBeUndefined()
    expect(checkField(note, '')).toBeUndefined()
  })

  it('takes empty text as filled unless the schema asks for a character, as the server judges it, and checks nothing of a toggle', () => {
    expect(checkField(name, '')).toBe('Name needs at least 3 characters')
    expect(checkField({ ...note, limits: { minLength: 1 } }, '')).toBe('Note is required')
    expect(checkField(flag, undefined)).toBeUndefined()
  })

  it('leaves a pattern a RegExp cannot compile to the server', () => {
    expect(checkField({ ...mail, limits: { pattern: '(' } }, 'anything')).toBeUndefined()
  })
})

describe('htmlPattern', () => {
  it('keeps a pattern the HTML attribute reads as the schema does: anchored at both ends, one alternative, valid with the v flag', () => {
    expect(htmlPattern('^[a-z]+$')).toBe('^[a-z]+$')
    expect(htmlPattern('^(a|b)$')).toBe('^(a|b)$')
    expect(htmlPattern('^[ab]$')).toBe('^[ab]$')
  })

  it('drops one the attribute would anchor differently, or not compile', () => {
    expect(htmlPattern('[a-z]+')).toBeUndefined()
    expect(htmlPattern('^[a-z]+')).toBeUndefined()
    expect(htmlPattern('[a-z]+$')).toBeUndefined()
    expect(htmlPattern('^a|b$')).toBeUndefined()
    expect(htmlPattern('^a\\$')).toBeUndefined()
    expect(htmlPattern('^[a-z-]$')).toBeUndefined()
    expect(htmlPattern('^[a|b]$')).toBeUndefined()
    expect(htmlPattern('^(a$')).toBeUndefined()
    // Read as the literal `p{L}` with no flag, as a letter class with the u or v flag.
    expect(htmlPattern('^\\p{L}+$')).toBeUndefined()
    expect(htmlPattern('^\\u{1F600}$')).toBeUndefined()
    expect(htmlPattern('^😀$')).toBeUndefined()
    expect(htmlPattern(undefined)).toBeUndefined()
  })

  it('drops one that would meet an astral character differently: a dot, a negated class, \\S, \\W or \\D', () => {
    for (const pattern of ['^.{3}$', '^[^a]+$', '^\\S+$', '^\\W$', '^\\D*$', '^a.$'])
      expect(htmlPattern(pattern)).toBeUndefined()

    expect(htmlPattern('^\\.[a-z]\\\\$')).toBe('^\\.[a-z]\\\\$')
    expect(htmlPattern('^\\d+\\w$')).toBe('^\\d+\\w$')
  })
})
