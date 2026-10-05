import { describe, expect, test } from 'bun:test'
import { laneCount, masonryLayout } from '../src/masonry'

describe('laneCount', () => {
  test('fits as many lanes as the minimum width allows, gaps counted, and never fewer than one', () => {
    expect(laneCount(1000, 240, 12)).toBe(4)
    expect(laneCount(1008, 240, 12)).toBe(4)
    expect(laneCount(1020, 240, 12)).toBe(4)
    expect(laneCount(1248, 240, 12)).toBe(5)
    expect(laneCount(200, 240, 12)).toBe(1)
    expect(laneCount(0, 240, 12)).toBe(1)
  })
})

describe('masonryLayout', () => {
  test('drops each tile into the shortest lane, gaps between tiles and none below the last', () => {
    const { places, height } = masonryLayout([100, 40, 60, 30, 30], 3, 10, 0)

    expect(places).toEqual([
      { lane: 0, top: 0 },
      { lane: 1, top: 0 },
      { lane: 2, top: 0 },
      { lane: 1, top: 50 },
      { lane: 2, top: 70 },
    ])
    expect(height).toBe(100)
  })

  test('keeps to the leftmost lane when another is shorter by no more than the tolerance', () => {
    expect(masonryLayout([100, 90, 20], 2, 0, 16).places[2]).toEqual({ lane: 0, top: 100 })
    expect(masonryLayout([100, 80, 20], 2, 0, 16).places[2]).toEqual({ lane: 1, top: 80 })
  })

  test('gives a tile not measured yet no room, so it moves nothing already placed', () => {
    const { places, height } = masonryLayout([50, undefined, 30], 2, 10, 0)

    expect(places).toEqual([{ lane: 0, top: 0 }, { lane: 1, top: 0 }, { lane: 1, top: 0 }])
    expect(height).toBe(50)
  })

  test('is empty and flat with nothing to place', () => {
    expect(masonryLayout([], 3, 10)).toEqual({ places: [], height: 0 })
  })
})
