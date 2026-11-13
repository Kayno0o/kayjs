import { describe, expect, test } from 'bun:test'
import { bellItem } from '../src/bell'

describe('bellItem', () => {
  test('fills key, label and href from an inbox item, and keeps its own names', () => {
    expect(bellItem({ id: 'a', title: 'Deploy done', url: '/plain', read: true })).toEqual({ id: 'a', title: 'Deploy done', url: '/plain', read: true, key: 'a', label: 'Deploy done', href: '/plain' })
  })

  test('an item with no address has no href', () => {
    expect('href' in bellItem({ key: 'a', label: 'A' })).toBe(false)
  })
})
