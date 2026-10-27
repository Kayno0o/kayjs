import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import MapFixture from '../tests/fixture/src/components/map-view.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

// Leaflet loads after mount, so the map is waited for.
async function drawn(props: Record<string, unknown> = {}) {
  mounted = await mountComponent(MapFixture, props)

  for (let tries = 0; tries < 400 && mounted.root.querySelector('#map .leaflet-overlay-pane svg path') === null; tries++)
    await Bun.sleep(5)

  return mounted.root
}

// happy-dom lays nothing out, so every map is given a 600 by 400 box for Leaflet to draw tiles into.
async function laidOut(run: () => Promise<void>) {
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 })

  try {
    await run()
  }
  finally {
    for (const [name, descriptor] of [['clientWidth', width], ['clientHeight', height]] as const) {
      if (descriptor)
        Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else
        Reflect.deleteProperty(HTMLElement.prototype, name)
    }
  }
}

// The tile URLs a map shows, which tell its zoom and where it looks.
const tilesOf = (root: HTMLElement, map: string) => [...root.querySelectorAll(`${map} img.leaflet-tile`)].map(tile => (tile as HTMLImageElement).src).sort()

describe('MapView', () => {
  test('fits once a map mounted with no size gets one, and not before', async () => {
    const callbacks: (() => void)[] = []
    const { ResizeObserver: original } = globalThis

    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback)
      }

      observe = () => undefined
      disconnect = () => undefined
    } as unknown as typeof ResizeObserver

    try {
      const root = await drawn()
      const tiles = () => [...root.querySelectorAll('#sized img.leaflet-tile')].map(tile => (tile as HTMLImageElement).src).sort()
      const surface = root.querySelector('#sized .leaflet-container')!

      for (let tries = 0; tries < 400 && root.querySelector('#sized .leaflet-overlay-pane path') === null; tries++)
        await Bun.sleep(5)

      const before = tiles()

      Object.defineProperty(surface, 'clientWidth', { value: 600 })
      Object.defineProperty(surface, 'clientHeight', { value: 400 })

      for (const callback of callbacks)
        callback()

      expect(tiles().length).toBeGreaterThan(before.length)
    }
    finally {
      globalThis.ResizeObserver = original
    }
  })

  test('asks whether the visitor prefers reduced motion, to fit without animating', async () => {
    const { matchMedia: original } = globalThis
    const queries: string[] = []

    globalThis.matchMedia = ((query: string) => {
      queries.push(query)

      return { matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }
    }) as unknown as typeof matchMedia

    try {
      await drawn()
      expect(queries).toContain('(prefers-reduced-motion: reduce)')
    }
    finally {
      globalThis.matchMedia = original
    }
  })

  test('names the region and lists the markers that have a label or a popup for screen readers', async () => {
    const root = await drawn()
    const region = root.querySelector('#map')!

    expect(region.getAttribute('role')).toBe('region')
    expect(region.getAttribute('aria-label')).toBe('Route')
    expect([...region.querySelectorAll('[data-part="list"] li')].map(item => item.textContent)).toEqual(['Start: <b>Start</b>', 'Halfway'])
    expect(root.querySelector('#empty [data-part="list"]')).toBeNull()
  })

  test('draws each line and marker, leaving out a point that is no place', async () => {
    const root = await drawn()
    const paths = [...root.querySelectorAll('#map .leaflet-overlay-pane path')]

    expect(paths.filter(path => path.classList.contains('kui-map-view-line'))).toHaveLength(2)
    expect(paths.filter(path => path.classList.contains('kui-map-view-marker'))).toHaveLength(3)
  })

  test('draws OpenStreetMap\'s tiles and attribution by default, and the given ones when set', async () => {
    const root = await drawn()

    expect(root.querySelector('#map .leaflet-control-attribution')?.textContent).toContain('OpenStreetMap')
    expect(root.querySelector('#map .leaflet-control-attribution a')?.getAttribute('href')).toBe('https://www.openstreetmap.org/copyright')
    expect(root.querySelector('#custom .leaflet-control-attribution')?.textContent).toBe('Example tiles')
    expect([...root.querySelectorAll('#custom img.leaflet-tile')].every(tile => (tile as HTMLImageElement).src.startsWith('https://tiles.example/'))).toBe(true)
  })

  test('draws a highlight over the lines, a casing under its accent, and drops it when unset', async () => {
    const root = await drawn({ highlight: [[48.85, 2.35], [48.86, 2.37]] })

    expect(root.querySelectorAll('#map path.kui-map-view-casing')).toHaveLength(1)
    expect(root.querySelectorAll('#map path.kui-map-view-pick')).toHaveLength(1)
  })

  test('draws a one-point highlight as a dot', async () => {
    const root = await drawn({ highlight: [[48.85, 2.35]] })

    expect(root.querySelectorAll('#map path.kui-map-view-pick-dot')).toHaveLength(1)
    expect(root.querySelectorAll('#map path.kui-map-view-casing')).toHaveLength(0)
  })

  test('draws no layer for a map with nothing to draw', async () => {
    const root = await drawn()

    expect(root.querySelectorAll('#empty .leaflet-overlay-pane path')).toHaveLength(0)
    expect(root.querySelector('#empty .leaflet-control-zoom')).not.toBeNull()
  })

  test('shows a marker\'s label as a tooltip and its popup text as text, never markup', async () => {
    const root = await drawn()
    const start = [...root.querySelectorAll('#map path.kui-map-view-marker')][0]!

    start.dispatchEvent(new Event('click', { bubbles: true }))

    const popup = root.querySelector('#map .leaflet-popup-content')

    expect(popup?.textContent).toBe('<b>Start</b>')
    expect(popup?.querySelector('b')).toBeNull()
  })
  test('gives the markers with a label or a popup one tab stop, which the arrows walk, showing each label and opening a popup on Enter', async () => {
    const root = await drawn()
    const [start, plain, halfway] = [...root.querySelectorAll<SVGElement>('#map path.kui-map-view-marker')]

    expect([start, plain, halfway].map(marker => [marker?.getAttribute('tabindex'), marker?.getAttribute('role'), marker?.getAttribute('aria-label')])).toEqual([['0', 'button', 'Start'], [null, null, null], ['-1', 'img', 'Halfway']])

    start!.focus()
    expect(root.querySelector('#map .leaflet-tooltip')?.textContent).toBe('Start')

    start!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(root.querySelector('#map .leaflet-popup-content')?.textContent).toBe('<b>Start</b>')

    start!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(root.querySelector('#map .leaflet-popup-content')).toBeNull()

    start!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(halfway!)
    expect([start, halfway].map(marker => marker?.getAttribute('tabindex'))).toEqual(['-1', '0'])
    expect(root.querySelector('#map .leaflet-tooltip')?.textContent).toBe('Halfway')

    halfway!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(document.activeElement).toBe(start!)
  })

  test('fits the lines again when they change, unless the visitor moved the map, whose view then stays', async () => {
    await laidOut(async () => {
      const root = await drawn()
      const before = tilesOf(root, '#custom')

      await mounted!.setProps({ route: [[10, 10], [11, 11]] })
      await Bun.sleep(400)

      const refitted = tilesOf(root, '#custom')

      expect(refitted).not.toEqual(before)

      // Leaflet moves its pane by a pan, which happy-dom keeps as left and top.
      const pane = root.querySelector<HTMLElement>('#custom .leaflet-map-pane')!
      const fitted = Number.parseFloat(pane.style.left)

      root.querySelector<HTMLElement>('#custom .leaflet-container')!.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true }))
      await Bun.sleep(400)

      const panned = pane.style.left

      expect(Number.parseFloat(panned)).toBe(fitted - 80)
      await mounted!.setProps({ route: [[0, 0], [1, 1]] })
      await Bun.sleep(400)
      expect(pane.style.left).toBe(panned)
      expect(tilesOf(root, '#custom')).not.toContain(before[0])
    })
  })

  test('follows a change to tiles, attribution and maxZoom', async () => {
    await laidOut(async () => {
      const root = await drawn()

      expect(tilesOf(root, '#custom').every(tile => tile.startsWith('https://tiles.example/8/'))).toBe(true)
      await mounted!.setProps({ tiles: 'https://other.example/{z}/{x}/{y}.png', attribution: 'Other tiles', maxZoom: 3 })

      const tiles = tilesOf(root, '#custom')

      expect(tiles.length).toBeGreaterThan(0)
      expect(tiles.every(tile => tile.startsWith('https://other.example/3/'))).toBe(true)
      expect(root.querySelector('#custom .leaflet-control-attribution')?.textContent).toBe('Other tiles')
      expect(root.querySelector('#custom .leaflet-control-zoom-in')?.classList.contains('leaflet-disabled')).toBe(true)
    })
  })

  test('darkens the tiles while its colour scheme is dark, following data-theme, or draws darkTiles in their place', async () => {
    // happy-dom computes no color-scheme, so the theme's rule is stood in for.
    const { getComputedStyle: original } = globalThis

    globalThis.getComputedStyle = ((element: Element) => ({ colorScheme: element.closest('[data-theme="dark"]') ? 'dark' : 'light' })) as unknown as typeof getComputedStyle

    try {
      await laidOut(async () => {
        const root = await drawn()
        const canvas = () => root.querySelector('#custom [data-part="canvas"]')!

        expect(canvas().hasAttribute('data-dark-tiles')).toBe(false)
        root.setAttribute('data-theme', 'dark')
        await Bun.sleep(0)
        expect(canvas().hasAttribute('data-dark-tiles')).toBe(true)

        await mounted!.setProps({ darkTiles: 'https://dark.example/{z}/{x}/{y}.png' })
        expect(canvas().hasAttribute('data-dark-tiles')).toBe(false)
        expect(tilesOf(root, '#custom').every(tile => tile.startsWith('https://dark.example/'))).toBe(true)

        root.removeAttribute('data-theme')
        await Bun.sleep(0)
        expect(tilesOf(root, '#custom').every(tile => tile.startsWith('https://tiles.example/'))).toBe(true)
      })
    }
    finally {
      globalThis.getComputedStyle = original
    }
  })
})
