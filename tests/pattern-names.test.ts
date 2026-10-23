import { describe, expect, it } from 'bun:test'
import { parsedBindingNames } from '../src/compiler/pattern-names'

describe('parsedBindingNames', () => {
  it('parses a pattern ending in a line comment', () => {
    expect(parsedBindingNames('{ a, b } // the item')).toEqual(['a', 'b'])
  })

  it('parses a parameter list whose last parameter is followed by a line comment', () => {
    expect(parsedBindingNames('item, index // the position')).toEqual(['item', 'index'])
  })

  it('gives undefined for a pattern that does not parse', () => {
    expect(parsedBindingNames('{ a, ')).toBeUndefined()
  })
})
