import type { Mounted } from 'kay/test'
import type { ScatterPoint } from '../src/plot'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
const selected: string[] = []
const ranges: [number, number][] = []

afterEach(() => {
  mounted?.unmount()
  selected.length = 0
  ranges.length = 0
})

async function charts() {
  mounted = await mountComponent('src/components/charts.kay', { onSelect: (point: ScatterPoint) => selected.push(point.label), onRange: (from: number, to: number) => ranges.push([from, to]) })

  return mounted.root
}

describe('LineChart', () => {
  test('puts the data table in a block that is visually hidden, as a table box would scroll the page by its full height', async () => {
    const root = await charts()
    const block = root.querySelector('#line .kui-line-chart-data')!
    const table = block.querySelector(':scope > table')!

    expect(block.tagName).toBe('DIV')
    expect(table.className).toBe('')
    expect(table.querySelector('caption')?.textContent).toBe('Visits')
    expect(table.querySelectorAll('thead th[scope="col"]')).toHaveLength(2)
    expect(table.querySelectorAll('tbody th[scope="row"]').length).toBeGreaterThan(0)
  })

  test('draws each series in its colour, the next palette token for one without, and in its own dash after the first', async () => {
    const root = await charts()
    const lines = [...root.querySelectorAll('#line .ct-line')].map(line => line.getAttribute('style'))

    expect(lines).toEqual(['stroke: var(--kui-chart-1)', 'stroke: red; stroke-dasharray: 6 3'])
  })

  test('walks the points from the keyboard, announcing each one\'s readings, and picks a span with Shift then Enter', async () => {
    const root = await charts()
    const slider = root.querySelector<HTMLElement>('#line [role="slider"]')!
    const press = async (key: string, shiftKey = false) => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
      await settle()
    }

    expect(slider.getAttribute('aria-valuetext')).toBe('Wed: Visits 5 v, Sales 1 v')

    await press('Home')
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
    expect(slider.getAttribute('aria-valuetext')).toBe('Mon: Visits -, Sales 1 v')
    expect(root.querySelector('.kui-line-chart-tooltip-label')?.textContent).toBe('Mon')

    await press('ArrowRight', true)
    await press('ArrowRight', true)
    expect(slider.getAttribute('aria-valuetext')).toBe('Wed: Visits 5 v, Sales 1 v; Mon - Wed')

    await press('Enter')
    expect(ranges).toEqual([[0, 2]])

    await press('ArrowLeft', true)
    await press('Escape')
    await press('Enter')
    expect(ranges).toEqual([[0, 2]])
    expect(slider.getAttribute('aria-valuetext')).toBe('Tue: Visits 3 v, Sales 2 v')
  })

  test('leaves chords to the browser, Alt with an arrow going back', async () => {
    const root = await charts()
    const slider = root.querySelector<HTMLElement>('#line [role="slider"]')!

    for (const chord of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', ...chord, bubbles: true, cancelable: true })

      slider.dispatchEvent(event)
      await settle()
      expect(event.defaultPrevented).toBe(false)
      expect(slider.getAttribute('aria-valuenow')).toBe('2')
    }
  })

  test('drops the point it stood on once the app zooms in on a picked span, reading the new points', async () => {
    const root = await charts()
    const slider = root.querySelector<HTMLElement>('#line [role="slider"]')!
    const press = async (key: string, shiftKey = false) => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
      await settle()
    }

    await press('Home')
    await press('ArrowRight')
    await press('ArrowRight', true)
    await press('Enter')

    expect(ranges).toEqual([[1, 2]])
    expect(slider.getAttribute('aria-valuemax')).toBe('1')
    expect(slider.getAttribute('aria-valuenow')).toBe('1')
    expect(slider.getAttribute('aria-valuetext')).toBe('Wed: Visits 5 v, Sales 1 v')
    expect(root.querySelector('.kui-line-chart-tooltip')).toBeNull()

    await press('Home')
    expect(slider.getAttribute('aria-valuetext')).toBe('Tue: Visits 3 v, Sales 2 v')
  })

  test('tells screen readers how to pick a span once the chart takes onRange', async () => {
    const root = await charts()
    const slider = root.querySelector('#line [role="slider"]')!

    expect(document.getElementById(slider.getAttribute('aria-describedby')!)?.textContent).toBe('Shift with the arrow keys picks a span, Enter applies it, Escape drops it')
  })

  test('reads every series at the hovered point in its tooltip, a gap as a dash', async () => {
    const root = await charts()
    const overlay = root.querySelector('#line .kui-line-chart-overlay')!

    overlay.dispatchEvent(new PointerEvent('pointermove', { clientX: 0, clientY: 0, bubbles: true }))
    await settle()

    const rows = () => [...root.querySelectorAll('.kui-line-chart-tooltip-row')].map(row => [row.querySelector('.kui-line-chart-tooltip-name')?.textContent, row.querySelector('.kui-line-chart-tooltip-value')?.textContent])

    expect(root.querySelector('.kui-line-chart-tooltip-label')?.textContent).toBe('Mon')
    expect(rows()).toEqual([['Visits', '-'], ['Sales', '1 v']])
    expect([...root.querySelectorAll<HTMLElement>('.kui-line-chart-dot')].map(dot => dot.style.backgroundColor)).toEqual(['red'])

    overlay.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
    await settle()

    expect(root.querySelector('.kui-line-chart-tooltip')).toBeNull()
  })

  test('hands over the span a drag covers, first point first, and nothing for a press in place', async () => {
    const root = await charts()
    const overlay = root.querySelector('#line .kui-line-chart-overlay')!
    const rect = root.querySelector('#line .kui-line-chart-plot')!.getBoundingClientRect()
    const pointer = (type: string, x: number) => overlay.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 0, button: 0, bubbles: true }))

    pointer('pointerdown', rect.right + 100)
    pointer('pointermove', 0)
    await settle()

    expect(root.querySelector('#line .kui-line-chart-band')).not.toBeNull()

    pointer('pointerup', 0)
    pointer('pointerdown', 0)
    pointer('pointerup', 0)
    await settle()

    expect(ranges).toEqual([[0, 2]])
    expect(root.querySelector('#line .kui-line-chart-band')).toBeNull()
  })
})

describe('ScatterChart', () => {
  test('makes each dot a button handing back its point once the chart takes onSelect', async () => {
    const root = await charts()

    click(root.querySelectorAll('#scatter button.kui-scatter-chart-dot')[1]!)

    expect(selected).toEqual(['Celeste'])
  })
})
