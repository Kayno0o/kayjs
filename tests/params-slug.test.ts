import { describe, expect, test } from 'bun:test'
import { slug } from '../src/runtime/params'

describe('slug matcher', () => {
  test('keeps accepting the ASCII slugs it always did', () => {
    for (const value of ['a', 'abc-def', 'a1-2b', '2024', 'x-1-y'])
      expect(slug(value)).toBe(value)
  })

  test('accepts letters and digits of any script, marks and underscores', () => {
    for (const value of ['été', 'привет-мир', '你好-世界', 'مرحبا-بالعالم', 'हिन्दी', 'a_b', '_a', 'a_', 'a/b', 'a/b-c/d'])
      expect(slug(value)).toBe(value)
  })

  test('refuses uppercase, empty values, doubled or edge separators and everything else', () => {
    for (const value of ['', 'A', 'Été', 'a--b', '-a', 'a-', '/a', 'a/', 'a//b', 'a-/b', 'a/-b', 'a b', 'a.b', 'a%20b', '..', 'a\n', '-', '/'])
      expect(slug(value)).toBeUndefined()
  })
})
