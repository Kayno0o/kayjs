import { describe, expect, test } from 'bun:test'
import { INITIAL_VIEWPORT, offsetsOf, windowOf } from '../src/virtual'

const even = offsetsOf(1000, () => 10)

describe('offsetsOf', () => {
  test('sums the heights, the total last', () => {
    expect([...offsetsOf(3, index => [10, 20, 30][index]!)]).toEqual([0, 10, 30, 60])
    expect([...offsetsOf(0, () => 1)]).toEqual([0])
  })
})

describe('windowOf', () => {
  test('keeps the rows in view with the overscan on each side', () => {
    expect(windowOf(even, 0, 100, 2)).toEqual({ start: 0, end: 12 })
    expect(windowOf(even, 500, 100, 2)).toEqual({ start: 48, end: 62 })
  })

  test('counts a row cut by the top edge, and one starting right at the bottom edge as out of view', () => {
    expect(windowOf(even, 505, 100, 0)).toEqual({ start: 50, end: 61 })
    expect(windowOf(even, 500, 100, 0)).toEqual({ start: 50, end: 60 })
  })

  test('follows rows of different heights', () => {
    const uneven = offsetsOf(4, index => [100, 10, 10, 100][index]!)

    expect(windowOf(uneven, 105, 5, 0)).toEqual({ start: 1, end: 2 })
    expect(windowOf(uneven, 105, 30, 0)).toEqual({ start: 1, end: 4 })
  })

  test('stays inside the list for a scroll position past its end, or an empty list', () => {
    expect(windowOf(even, 99999, 100, 3)).toEqual({ start: 996, end: 1000 })
    expect(windowOf(even, -50, 100, 0)).toEqual({ start: 0, end: 10 })
    expect(windowOf(offsetsOf(0, () => 1), 0, 100, 3)).toEqual({ start: 0, end: 0 })
  })

  test('draws a bounded number of rows however long the list', () => {
    const long = offsetsOf(200_000, () => 48)
    const { start, end } = windowOf(long, 48 * 100_000, INITIAL_VIEWPORT, 4)

    expect(end - start).toBeLessThan(30)
  })
})
