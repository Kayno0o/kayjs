import { describe, expect, it } from 'bun:test'
import { fieldAtPath, inlineValue } from '../src/editor/inline'
import { fieldsOf } from '../src/fields'

const block = (type: string, properties: Record<string, unknown>) => ({ type: 'object', properties: { type: { const: type }, ...properties }, required: ['type'] })
const fields = fieldsOf({
  type: 'object',
  properties: {
    title: { type: 'string' },
    seo: { type: 'object', properties: { description: { type: 'string' } } },
    tags: { type: 'array', items: { type: 'string' } },
    sections: { 'type': 'array', 'x-kay': { kind: 'blocks' }, 'items': { 'anyOf': [block('hero', { heading: { type: 'string' } }), block('text', { items: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } } })], 'x-kay': { kind: 'block' } } },
  },
})
const data = { sections: [{ type: 'hero', heading: 'Hi' }, { type: 'text', items: [{ label: 'One' }] }] }

describe('the field a marker path names', () => {
  it('finds a field of the entry, of a group, of a block and of a list inside a block', () => {
    expect(fieldAtPath(fields, data, 'title')?.kind).toBe('text')
    expect(fieldAtPath(fields, data, 'seo.description')?.kind).toBe('text')
    expect(fieldAtPath(fields, data, 'sections.0.heading')?.kind).toBe('text')
    expect(fieldAtPath(fields, data, 'sections.1.items.0.label')?.kind).toBe('text')
  })

  it('finds an item of a list of texts', () => {
    expect(fieldAtPath(fields, data, 'tags.3')?.kind).toBe('text')
  })

  it('finds nothing for a path the schema does not have, a block of another type, or an index that is no number', () => {
    expect(fieldAtPath(fields, data, 'nope')).toBeUndefined()
    expect(fieldAtPath(fields, data, 'title.deeper')).toBeUndefined()
    expect(fieldAtPath(fields, data, 'sections.0.items')).toBeUndefined()
    expect(fieldAtPath(fields, data, 'sections.x.heading')).toBeUndefined()
    expect(fieldAtPath(fields, data, 'sections.-1.heading')).toBeUndefined()
    expect(fieldAtPath(fields, undefined, 'sections.0.heading')).toBeUndefined()
  })
})

describe('the value typed in place', () => {
  const optional = fieldsOf({ type: 'object', properties: { a: { type: 'string' } } })[0]!
  const required = fieldsOf({ type: 'object', required: ['a'], properties: { a: { type: 'string' } } })[0]!
  const nullable = fieldsOf({ type: 'object', required: ['a'], properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] } } })[0]!

  it('is the text, as one line', () => {
    expect(inlineValue(optional, 'a\nb\r\n\nc\u00A0d')).toBe('a b c d')
  })

  it('is kept as text whatever markup it looks like', () => {
    expect(inlineValue(optional, '<b>x</b> &amp;')).toBe('<b>x</b> &amp;')
  })

  it('unsets an emptied optional text, stores null for a nullable one and keeps a required one empty', () => {
    expect(inlineValue(optional, '')).toBeUndefined()
    expect(inlineValue(nullable, '')).toBeNull()
    expect(inlineValue(required, '')).toBe('')
  })
})
