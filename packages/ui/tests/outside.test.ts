import { describe, expect, test } from 'bun:test'
import { isExternal, OUTSIDE, tabOf } from '../src/outside'

describe('isExternal', () => {
  test('reads an absolute or protocol-relative address as another site, a path or anchor as this one', () => {
    for (const href of ['https://example.com', 'http://example.com/a', '//example.com/a'])
      expect(isExternal(href)).toBe(true)

    for (const href of ['/orders/12', 'orders', '#top', '?page=2', 'mailto:a@b.c', '/\\host'])
      expect(isExternal(href)).toBe(false)
  })
})

describe('tabOf', () => {
  test('opens an address leaving the site in a new tab by default', () => {
    expect(tabOf('https://example.com')).toBe(OUTSIDE)
    expect(tabOf('https://example.com', 'auto')).toBe(OUTSIDE)
    expect(tabOf('/orders')).toEqual({})
    expect(tabOf(undefined)).toEqual({})
  })

  test('`true` always opens a new tab, `false` never', () => {
    expect(tabOf('/orders', true)).toBe(OUTSIDE)
    expect(tabOf('https://example.com', false)).toEqual({})
  })

  test('the new tab carries noopener noreferrer', () => {
    expect(OUTSIDE.rel).toBe('noopener noreferrer')
    expect(OUTSIDE.target).toBe('_blank')
  })
})
