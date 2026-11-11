import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { comesIntoView, drawnPoints, OSM_ATTRIBUTION, OSM_TILES, validPoint } from '../src/map-view'

describe('waiting for a map to come into view', () => {
  const real = globalThis.IntersectionObserver
  const watchers: { options: IntersectionObserverInit | undefined, report: (visible: boolean) => void, disconnected: boolean }[] = []

  beforeEach(() => {
    watchers.length = 0
    globalThis.IntersectionObserver = class {
      watcher: (typeof watchers)[number]

      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.watcher = { options, disconnected: false, report: visible => callback([{ isIntersecting: visible }] as IntersectionObserverEntry[], this as unknown as IntersectionObserver) }
        watchers.push(this.watcher)
      }

      observe = () => undefined
      disconnect() {
        this.watcher.disconnected = true
      }
    } as unknown as typeof IntersectionObserver
  })

  afterEach(() => {
    globalThis.IntersectionObserver = real
  })

  test('resolves only once the map is near the viewport, then stops watching', async () => {
    let loaded = false
    const { near } = comesIntoView({} as Element)
    const settled = (async () => {
      await near
      loaded = true
    })()

    watchers[0]!.report(false)
    await Promise.resolve()
    expect(loaded).toBe(false)
    expect(watchers[0]!.options?.rootMargin).toBe('300px')

    watchers[0]!.report(true)
    await settled
    expect(loaded).toBe(true)
    expect(watchers[0]!.disconnected).toBe(true)
  })

  test('stops watching when the map goes before it came into view', () => {
    comesIntoView({} as Element).stop()
    expect(watchers[0]!.disconnected).toBe(true)
  })

  test('resolves at once where nothing can observe', async () => {
    Reflect.deleteProperty(globalThis, 'IntersectionObserver')

    await comesIntoView({} as Element).near
  })
})

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
  expect(validPoint([48.85])).toBe(false)
  expect(validPoint([48.85, 2.35, 30])).toBe(false)
})

test('defaults to OpenStreetMap\'s tiles over https, which kay\'s default img-src admits, and credits it', () => {
  expect(OSM_TILES.startsWith('https://')).toBe(true)
  expect(OSM_ATTRIBUTION).toContain('OpenStreetMap')
})
