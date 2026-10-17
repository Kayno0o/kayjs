import { describe, expect, it } from 'bun:test'
import { movable, moveChanges, orderValue, sortOrdered } from '../src/order'

const entry = (slug: string, order?: number | string, locale?: string) => ({ slug, locale, data: order === undefined ? {} : { order } })

describe('sortOrdered', () => {
  it('sorts by the field, those without a number last, then by slug', () => {
    const sorted = sortOrdered([entry('d'), entry('c', 2), entry('b', 'x'), entry('a', 1), entry('e', 1)], 'order')

    expect(sorted.map(each => each.slug)).toEqual(['a', 'e', 'c', 'b', 'd'])
  })

  it('reads no number from text, NaN or an entry without data', () => {
    expect(orderValue({ data: { order: '2' } }, 'order')).toBeUndefined()
    expect(orderValue({ data: { order: Number.NaN } }, 'order')).toBeUndefined()
    expect(orderValue({ data: undefined }, 'order')).toBeUndefined()
    expect(orderValue({ data: { order: 0 } }, 'order')).toBe(0)
  })
})

describe('movable', () => {
  it('keeps the entries of the locale whose data reads', () => {
    const found = [entry('a', 1, 'fr'), entry('b', 2, 'en'), { slug: 'c', locale: 'fr', data: undefined }]

    expect(movable(found, 'fr').map(each => each.slug)).toEqual(['a'])
  })
})

describe('moveChanges', () => {
  const group = (...values: (number | undefined)[]) => values.map((value, i) => ({ slug: `s${i}`, value }))

  it('swaps the values of two neighbours when every value is its own', () => {
    expect(moveChanges(group(10, 20, 30), 's2', 'up')).toEqual([{ slug: 's2', value: 20 }, { slug: 's1', value: 30 }])
    expect(moveChanges(group(10, 20, 30), 's0', 'down')).toEqual([{ slug: 's0', value: 20 }, { slug: 's1', value: 10 }])
  })

  it('numbers the group from 1 when values repeat or are missing, writing only what changes', () => {
    expect(moveChanges(group(1, 1, 2), 's2', 'up')).toEqual([{ slug: 's1', value: 3 }])
    expect(moveChanges(group(1, undefined, undefined), 's1', 'down')).toEqual([{ slug: 's2', value: 2 }, { slug: 's1', value: 3 }])
  })

  it('does nothing at either end or for an entry outside the group', () => {
    expect(moveChanges(group(1, 2), 's0', 'up')).toBeUndefined()
    expect(moveChanges(group(1, 2), 's1', 'down')).toBeUndefined()
    expect(moveChanges(group(1, 2), 'gone', 'up')).toBeUndefined()
  })
})
