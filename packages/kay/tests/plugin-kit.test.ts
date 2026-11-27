import { describe, expect, test } from 'bun:test'
import { isInside } from '../src/plugins/public'

describe('isInside: the one path confinement check (#3672)', () => {
  test('a child and a grandchild are inside, the folder itself only with orSame', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b/c/d.md')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(false)
    expect(isInside('/a/b', '/a/b', { orSame: true })).toBe(true)
  })

  test('a name starting with two dots is inside', () => {
    expect(isInside('/a/b', '/a/b/..x')).toBe(true)
    expect(isInside('/a/b', '/a/b/..x/y', { orSame: true })).toBe(true)
  })

  test('the parent, a sibling, a sibling sharing the prefix and another root are outside', () => {
    expect(isInside('/a/b', '/a')).toBe(false)
    expect(isInside('/a/b', '/a', { orSame: true })).toBe(false)
    expect(isInside('/a/b', '/a/x')).toBe(false)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a/b/../c')).toBe(false)
    expect(isInside('/a/b', '/z/b/c')).toBe(false)
  })

  test('a trailing slash on either side changes nothing', () => {
    expect(isInside('/a/b/', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b/', { orSame: true })).toBe(true)
    expect(isInside('/a/b/', '/a/b')).toBe(false)
  })
})
