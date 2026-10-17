import { describe, expect, test } from 'bun:test'
import { collectionPath, entryPath, newEntryPath, onPagePath } from '../src/listing'
import { screenPath } from '../src/paths'

describe('screenPath', () => {
  test('puts the root prefix away, so no address starts with //', () => {
    expect(screenPath('/')).toBe('/')
    expect(screenPath('/', '/uploads')).toBe('/uploads')
    expect(screenPath('/admin')).toBe('/admin')
    expect(screenPath('/admin', '/uploads')).toBe('/admin/uploads')
    expect(screenPath('/a/b/c', '/uploads')).toBe('/a/b/c/uploads')
  })
})

const PREFIXES = ['/', '/admin', '/studio/cms/admin'] as const

describe('the paths the parts write, under each prefix', () => {
  test.each(PREFIXES)('%s', (prefix) => {
    const root = prefix === '/' ? '' : prefix

    expect(collectionPath(prefix, 'posts')).toBe(`${root}/collections/posts`)
    expect(newEntryPath(prefix, 'my posts')).toBe(`${root}/new/my%20posts`)
    expect(onPagePath(prefix, '/blog/a b')).toBe(`${root}/page?path=%2Fblog%2Fa%20b`)
    expect(entryPath(prefix, { collection: 'posts', slug: 'notes/a b@c' })).toBe(`${root}/collections/posts/notes/a%20b%40c`)
    expect(entryPath(prefix, { collection: 'posts', slug: '/lead' })).toBe(`${root}/collections/posts/%2Flead`)
    expect(entryPath(prefix, { collection: 'posts', slug: 'hello', locale: 'pt-BR' })).toBe(`${root}/collections/posts/hello?locale=pt-BR`)
    expect(entryPath(prefix, { collection: 'posts', slug: 'a@b c', locale: 'fr' })).toBe(`${root}/collections/posts/a%40b%20c?locale=fr`)
  })
})
