import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { loop, loopIdentity, rowKey } from '../src/runtime/html'

const draw = <T>(items: T[], key?: (item: T, index: number) => unknown, inner?: () => string) => loop(items, () => `[${loopIdentity() ?? '-'}${inner?.() ?? ''}]`, undefined, undefined, key)

describe('the identity an island takes from the keyed loop it is drawn in', () => {
  it('is the key of the row, and none outside a loop or in a loop with no key', () => {
    expect(loopIdentity()).toBeUndefined()
    expect(draw([{ id: 1 }, { id: 2 }], item => item.id)).toBe('[1][2]')
    expect(draw([1, 2])).toBe('[-][-]')
    expect(draw(['a', 'b'], rowKey)).toBe('[a][b]')
    expect(draw([{ id: 7 }], rowKey)).toBe('[7]')
  })

  it('is none for a key that is not a string or a number, and for a row inside such a loop', () => {
    expect(draw([{ id: 1 }], item => item)).toBe('[-]')
    expect(draw([{ id: 1 }], item => item, () => draw([1], item => item))).toBe('[-[-]]')
  })

  it('names the keys of nested loops together, outermost first', () => {
    expect(draw(['a'], key => key, () => draw([1], key => key))).toBe('[a[["a","1"]]]')
  })

  it('is given back when a row throws', () => {
    const failing = () => {
      throw new Error('row')
    }

    expect(() => loop([1], failing, undefined, undefined, key => key)).toThrow('row')
    expect(loopIdentity()).toBeUndefined()
  })
})

describe('the loop the server renders', () => {
  const html = (source: string) => compileKay(source, 'test.kay', { output: 'html' }).tsx

  it('is handed the key of the loop, or the row key when it names none, and none by position', () => {
    expect(html('for item of items key={item.slug}\n  li {item.name}')).toContain('(item) => (item.slug)))')
    expect(html('for item of items\n  li {item.name}')).toContain('undefined, undefined, KayRowKey))')
    expect(html('for item, i of items key={i}\n  li {item.name}')).not.toContain('KayRowKey))')
  })
})
