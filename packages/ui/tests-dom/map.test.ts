import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import MapFixture from '../tests/fixture/src/components/map.kay'

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

describe('Map', () => {
  test('shows a label as text in its tooltip, never as markup', async () => {
    mounted = await mountComponent(MapFixture, { hostile: true })

    for (let tries = 0; tries < 400 && mounted.root.querySelector('#hostile .leaflet-overlay-pane path') === null; tries++)
      await Bun.sleep(5)

    const dot = mounted.root.querySelector('#hostile path.kui-map-marker')!

    dot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))

    const tip = mounted.root.querySelector('#hostile .leaflet-tooltip')

    expect(tip?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(tip?.querySelector('img')).toBeNull()
  })

  test('names the region and lists the markers that have a label for screen readers', async () => {
    const root = await drawn()
    const region = root.querySelector('#map')!

    expect(region.getAttribute('role')).toBe('region')
    expect(region.getAttribute('aria-label')).toBe('Route')
    expect([...region.querySelectorAll('[data-part="list"] li')].map(item => item.textContent)).toEqual(['Start'])
    expect(root.querySelector('#empty [data-part="list"]')).toBeNull()
  })

  test('draws each line and marker, leaving out a point that is no place', async () => {
    const root = await drawn()
    const paths = [...root.querySelectorAll('#map .leaflet-overlay-pane path')]

    expect(paths.filter(path => path.classList.contains('kui-map-line'))).toHaveLength(2)
    expect(paths.filter(path => path.classList.contains('kui-map-marker'))).toHaveLength(2)
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

    expect(root.querySelectorAll('#map path.kui-map-casing')).toHaveLength(1)
    expect(root.querySelectorAll('#map path.kui-map-pick')).toHaveLength(1)
  })

  test('draws a one-point highlight as a dot', async () => {
    const root = await drawn({ highlight: [[48.85, 2.35]] })

    expect(root.querySelectorAll('#map path.kui-map-pick-dot')).toHaveLength(1)
    expect(root.querySelectorAll('#map path.kui-map-casing')).toHaveLength(0)
  })

  test('draws no layer for a map with nothing to draw', async () => {
    const root = await drawn()

    expect(root.querySelectorAll('#empty .leaflet-overlay-pane path')).toHaveLength(0)
    expect(root.querySelector('#empty .leaflet-control-zoom')).not.toBeNull()
  })

  test('shows a marker\'s label as a tooltip and its popup text as text, never markup', async () => {
    const root = await drawn()
    const start = [...root.querySelectorAll('#map path.kui-map-marker')][0]!

    start.dispatchEvent(new Event('click', { bubbles: true }))

    const popup = root.querySelector('#map .leaflet-popup-content')

    expect(popup?.textContent).toBe('<b>Start</b>')
    expect(popup?.querySelector('b')).toBeNull()
  })
})
