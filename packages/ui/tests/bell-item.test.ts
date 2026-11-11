import { describe, expect, test } from 'bun:test'
import { bellItem } from '../src/bell'

describe('bellItem', () => {
  test('fills key, label and href from the names before 1.100, and keeps those', () => {
    expect(bellItem({ id: 'a', title: 'Deploy done', url: '/plain', read: true })).toEqual({ id: 'a', title: 'Deploy done', url: '/plain', read: true, key: 'a', label: 'Deploy done', href: '/plain' })
  })

  test('the new names win when both are given', () => {
    const note = bellItem({ key: 'k', id: 'a', label: 'New', title: 'Old', href: '/new', url: '/old' })

    expect([note.key, note.label, note.href]).toEqual(['k', 'New', '/new'])
  })

  test('an item with no address has no href', () => {
    expect('href' in bellItem({ key: 'a', label: 'A' })).toBe(false)
  })
})
