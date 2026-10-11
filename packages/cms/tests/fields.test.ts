import type { Field } from '../src/fields'
import { describe, expect, it } from 'bun:test'
import { emptyValue, fieldsOf, humanize } from '../src/fields'

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

    expect(emptyValue(item as Field)).toEqual({ label: '', on: false, count: undefined, size: 's', tags: [] })
  })
})
