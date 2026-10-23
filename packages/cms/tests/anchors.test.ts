import { expect, it } from 'bun:test'
import { anchorsOf, covers, keyOfPath } from '../src/editor/anchors'
import { fieldsOf } from '../src/fields'
import { BODY } from '../src/markers'

const fields = fieldsOf({
  type: 'object',
  properties: {
    title: { type: 'string' },
    seo: { type: 'object', properties: { description: { type: 'string' }, image: { type: 'string' } } },
    items: { type: 'array', items: { type: 'string' } },
  },
})

it('lists the items of the form in the order it draws them, the body last', () => {
  expect(anchorsOf(fields, true)).toEqual([{ key: 'title', label: 'Title' }, { key: 'seo', label: 'Seo' }, { key: 'items', label: 'Items' }, { key: '#body', label: 'Body' }])
  expect(anchorsOf(fields, false).map(anchor => anchor.key)).toEqual(['title', 'seo', 'items'])
})

it('follows the layout: a placed field of a group is an item of its own, named by its path', () => {
  expect(anchorsOf(fields, false, { fields: [['title', 'seo.description']] }).map(anchor => anchor.key)).toEqual(['title', 'seo.description', 'seo', 'items'])
  expect(anchorsOf(fields, false, { hide: ['items'] }).map(anchor => anchor.key)).toEqual(['title', 'seo'])
})

it('covers the item holding a path, however deep, and the items placed from inside the group a path names', () => {
  expect(covers('title', 'title')).toBe(true)
  expect(covers('items', 'items.2')).toBe(true)
  expect(covers('seo', 'seo.description')).toBe(true)
  expect(covers('seo.description', 'seo')).toBe(true)
  expect(covers('seo.description', 'seo.description')).toBe(true)
})

it('covers nothing of a name that only starts the same', () => {
  expect(covers('title', 'titles')).toBe(false)
  expect(covers('items', 'items2.0')).toBe(false)
  expect(covers('seo.description', 'seo.image')).toBe(false)
})

it('keeps the body to its own item', () => {
  expect(covers('#body', keyOfPath(BODY))).toBe(true)
  expect(covers('title', keyOfPath(BODY))).toBe(false)
  expect(covers('#body', 'title')).toBe(false)
})
