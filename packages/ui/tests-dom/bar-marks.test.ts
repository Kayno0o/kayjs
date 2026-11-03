import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import BarMarks from '../tests/fixture/src/components/bar-marks.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

async function marks(props: { steered?: number } = {}) {
  const heard: unknown[] = []

  mounted = await mountComponent(BarMarks, { heard, ...props })

  return { root: mounted.root, heard }
}

describe('BarChart marks', () => {
  test('a column is a button handing back its mark when the app listens to presses', async () => {
    const { root, heard } = await marks()
    const columns = root.querySelectorAll('#pressable [data-part="column"]')

    expect(columns[1]!.tagName).toBe('BUTTON')
    click(columns[1]!)
    expect(heard).toEqual([{ index: 1, label: 'b', values: [2] }])
  })

  test('a column with an address is a link, a plain click going to onSelect', async () => {
    const { root, heard } = await marks()
    const columns = root.querySelectorAll('#links [data-part="column"]')

    expect(columns[0]!.tagName).toBe('A')
    expect(columns[0]!.getAttribute('href')).toBe('#first')
    expect(columns[1]!.tagName).toBe('BUTTON')
    click(columns[0]!)
    expect(heard).toEqual(['a'])
  })

  test('reports the active column and follows a controlled one', async () => {
    const { root, heard } = await marks()
    const column = root.querySelectorAll('#pressable [data-part="column"]')[2]! as HTMLElement

    column.dispatchEvent(new Event('pointerenter'))
    column.dispatchEvent(new Event('pointerleave'))
    expect(heard).toEqual([2, null])
    mounted?.unmount()

    const controlled = await marks({ steered: 0 })

    expect(controlled.root.querySelectorAll('#steered [data-part="column"]')[0]!.hasAttribute('data-lit')).toBe(true)
    expect(controlled.root.querySelectorAll('#steered [data-part="column"]')[1]!.hasAttribute('data-lit')).toBe(false)
  })

  test('draws the tooltip block for the column the focus is on', async () => {
    const { root } = await marks()
    const column = root.querySelectorAll('#tipped [data-part="column"]')[1]! as HTMLElement

    expect(column.hasAttribute('data-tooltip')).toBe(false)
    column.dispatchEvent(new Event('focus'))
    await settle()
    expect(root.querySelector('#tipped [data-part="tooltip"] .own')?.textContent).toBe('b!')
  })

  test('Sparkline bars, ContributionGraph cells and ScatterChart dots take the same presses, links and active reports', async () => {
    const { root, heard } = await marks()
    const bars = root.querySelectorAll('#spark [data-part="item"]')

    expect(bars[0]!.tagName).toBe('BUTTON')
    expect(bars[2]!.tagName).toBe('A')
    click(bars[0]!)
    bars[1]!.dispatchEvent(new Event('pointerenter'))
    expect(heard).toEqual([{ index: 0, value: 1 }, 'spark:1'])
    heard.length = 0

    const cells = root.querySelectorAll('#grid [data-part="cell"]')

    expect(cells[1]!.getAttribute('href')).toBe('#full')
    click(cells[0]!)
    click(cells[1]!)
    expect(heard).toEqual(['2026-01-05', '2026-01-06'])
    heard.length = 0

    const dots = root.querySelectorAll('#dots [data-part="dot"]')

    expect(dots[0]!.tagName).toBe('BUTTON')
    expect(dots[1]!.tagName).toBe('A')
    click(dots[0]!)
    dots[1]!.dispatchEvent(new Event('focus'))
    await settle()
    expect(heard).toEqual(['p', 'dot:1'])
    expect(root.querySelector('#dots [data-part="tooltip"] .dot')?.textContent).toBe('Q?')
  })

  test('LineChart hears the point a click without a drag lands on, the active one and Enter, and draws a controlled one', async () => {
    const { root, heard } = await marks()
    const overlay = root.querySelector('#lined [data-part="overlay"]')!
    const pointer = (type: string) => overlay.dispatchEvent(new PointerEvent(type, { clientX: 0, clientY: 0, button: 0, bubbles: true }))

    pointer('pointermove')
    pointer('pointerdown')
    pointer('pointerup')
    await settle()
    expect(heard).toEqual([{ index: 0, label: 'a', values: [1] }, 'line:0'])
    heard.length = 0
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(heard).toEqual([{ index: 0, label: 'a', values: [1] }])
    mounted?.unmount()

    const driven = await marks({ steered: 1 })

    await settle()
    expect(driven.root.querySelector('#lined [data-part="cursor"]')).not.toBeNull()
  })
})
