import type { Mounted } from 'kay/test'
import type { ScatterPoint } from '../src/plot'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
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
  mounted = await mount('src/components/charts.kay', { onSelect: (point: ScatterPoint) => selected.push(point.label), onRange: (from: number, to: number) => ranges.push([from, to]) })

  return mounted.root
}

describe('LineChart', () => {
  test('draws each series in its colour, the next palette token for one without', async () => {
    const root = await charts()
    const lines = [...root.querySelectorAll('#line .ct-line')].map(line => line.getAttribute('style'))

    expect(lines).toEqual(['stroke: var(--kui-chart-1)', 'stroke: red'])
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
