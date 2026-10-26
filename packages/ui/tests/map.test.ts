import { expect, test } from 'bun:test'
import { drawnPoints, OSM_ATTRIBUTION, OSM_TILES, validPoint } from '../src/map'

test('draws every point of the lines and the markers, which the map fits into view', () => {
  expect(drawnPoints([[[1, 2], [3, 4]], [[5, 6]]], [{ at: [7, 8] }, { at: [9, 10], label: 'End' }])).toEqual([[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]])
  expect(drawnPoints([], [])).toEqual([])
})

test('leaves out a point no map can place', () => {
  expect(validPoint([48.85, 2.35])).toBe(true)
  expect(validPoint([-90, 180])).toBe(true)
  expect(validPoint([Number.NaN, 2])).toBe(false)
  expect(validPoint([1, Number.POSITIVE_INFINITY])).toBe(false)
  expect(validPoint([91, 0])).toBe(false)
  expect(validPoint([0, -181])).toBe(false)
})

test('defaults to OpenStreetMap\'s tiles over https, which kay\'s default img-src admits, and credits it', () => {
  expect(OSM_TILES.startsWith('https://')).toBe(true)
  expect(OSM_ATTRIBUTION).toContain('OpenStreetMap')
})
