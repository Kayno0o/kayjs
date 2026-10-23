import { expect, it } from 'bun:test'
import { anchorsOf, keyOfPath, ownerOf } from '../src/editor/anchors'
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

it('names the item of a body label the layout gives', () => {
  expect(anchorsOf(fields, true, { body: { label: 'Text' } }).at(-1)).toEqual({ key: '#body', label: 'Text' })
})

it('finds the item holding a path, however deep', () => {
  const keys = anchorsOf(fields, true)

  expect(ownerOf(keys, 'title')).toBe('title')
  expect(ownerOf(keys, 'items.2')).toBe('items')
  expect(ownerOf(keys, 'seo.description')).toBe('seo')
})

it('prefers the placed field over the group it was taken from', () => {
  const keys = anchorsOf(fields, false, { fields: [['title', 'seo.description']] })

  expect(ownerOf(keys, 'seo.description')).toBe('seo.description')
  expect(ownerOf(keys, 'seo.image')).toBe('seo')
})

it('finds nothing for a name that only starts the same, or a field the layout hides', () => {
  const keys = anchorsOf(fields, false, { hide: ['items'] })

  expect(ownerOf(keys, 'titles')).toBeUndefined()
  expect(ownerOf(keys, 'items.0')).toBeUndefined()
})

it('keeps the body to its own item', () => {
  const keys = anchorsOf(fields, true)

  expect(ownerOf(keys, keyOfPath(BODY))).toBe('#body')
  expect(ownerOf(keys, 'body')).toBeUndefined()
})
