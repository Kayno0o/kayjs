import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

// A stand-in for the observer happy-dom never fires: each one made is kept, to be fired by hand.
class Resize {
  static made: Resize[] = []

  constructor(public callback: (entries: unknown[]) => void) {
    Resize.made.push(this)
  }

  observe = () => undefined
  unobserve = () => undefined
  disconnect = () => undefined
}

const { ResizeObserver } = globalThis
let mounted: Mounted | undefined

beforeEach(() => {
  Resize.made = []
  Object.assign(globalThis, { ResizeObserver: Resize })
})

afterEach(() => {
  mounted?.unmount()
  Object.assign(globalThis, { ResizeObserver })
})

const rowsOf = (root: HTMLElement, selector: string) => [...root.querySelectorAll(selector)]

async function scrollTo(box: Element, top: number) {
  Object.defineProperty(box, 'scrollTop', { value: top, configurable: true })
  box.dispatchEvent(new Event('scroll'))
  await settle()
}

describe('VirtualList', () => {
  test('draws the first rows of a long list, numbered among all, with room standing for the others', async () => {
    mounted = await mountComponent('src/components/virtual-list.kay', { count: 1000 })

    const { root } = mounted
    const items = rowsOf(root, '[role="listitem"]')

    expect(items.length).toBeGreaterThan(10)
    expect(items.length).toBeLessThan(50)
    expect(items[0]?.getAttribute('aria-posinset')).toBe('1')
    expect(items[0]?.getAttribute('aria-setsize')).toBe('1000')
    expect(root.querySelector('[role="list"]')?.getAttribute('aria-label')).toBe('Rows')
    expect(root.querySelector('[role="list"]')?.getAttribute('tabindex')).toBe('0')

    const rooms = (root.querySelector('[role="presentation"]') as HTMLElement).style.paddingBlock

    expect(rooms).toBe(`0px ${(1000 - items.length) * 20}px`)
  })

  test('moves the window with the scroll, and draws a short list whole', async () => {
    mounted = await mountComponent('src/components/virtual-list.kay', { count: 1000 })

    const { root } = mounted

    await scrollTo(root.querySelector('[role="list"]')!, 20 * 500)

    const texts = rowsOf(root, '.cell').map(row => row.textContent)

    expect(texts).toContain('Row 500')
    expect(texts).not.toContain('Row 0')
    expect(texts.length).toBeLessThan(50)

    mounted.unmount()
    mounted = await mountComponent('src/components/virtual-list.kay', { count: 3 })

    expect(rowsOf(mounted.root, '.cell').map(row => row.textContent)).toEqual(['Row 0', 'Row 1', 'Row 2'])
  })

  test('takes the heights the rows measure in place of the estimate', async () => {
    mounted = await mountComponent('src/components/virtual-list.kay', { count: 100 })

    const { root } = mounted
    const before = rowsOf(root, '[role="listitem"]').length
    const first = root.querySelector('[role="listitem"]')!

    Resize.made.at(-1)!.callback([{ target: first, borderBoxSize: [{ blockSize: 60 }] }])
    await settle()

    const drawn = rowsOf(root, '[role="listitem"]').length
    const rooms = (root.querySelector('[role="presentation"]') as HTMLElement).style.paddingBlock

    // The taller first row pushes the others down, so fewer fit the window.
    expect(drawn).toBeLessThan(before)
    expect(rooms).toBe(`0px ${(100 - drawn) * 20}px`)
  })
})

describe('Table with virtual', () => {
  test('draws the rows in view of a long table, numbered from the header row, between two spacer rows', async () => {
    mounted = await mountComponent('src/components/virtual-table.kay', { count: 5000 })

    const { root } = mounted
    const rows = rowsOf(root, 'tbody tr.kui-table-row')

    expect(rows.length).toBeLessThan(60)
    expect(root.querySelector('table')?.getAttribute('aria-rowcount')).toBe('5001')
    expect(rows[0]?.getAttribute('aria-rowindex')).toBe('2')
    expect(root.querySelector('.kui-table-wrap')?.getAttribute('tabindex')).toBe('0')

    const spacers = rowsOf(root, 'tbody tr[aria-hidden]') as HTMLElement[]

    expect(spacers).toHaveLength(1)
    expect(spacers[0]?.style.height).toBe(`${(5000 - rows.length) * 48}px`)

    await scrollTo(root.querySelector('.kui-table-wrap')!, 48 * 2000)

    const texts = rowsOf(root, 'tbody tr.kui-table-row .kui-table-cell-body').map(cell => cell.textContent)

    expect(texts).toContain('Row 2000')
    expect(texts).not.toContain('Row 0')
    expect(rowsOf(root, 'tbody tr[aria-hidden]')).toHaveLength(2)
  })

  test('draws every row without it', async () => {
    mounted = await mountComponent('src/components/table.kay', { rows: [{ id: 1, name: 'Mars', moons: 2 }, { id: 2, name: 'Earth', moons: 1 }] })

    expect(rowsOf(mounted.root, 'tbody tr')).toHaveLength(2)
    expect(mounted.root.querySelector('table')?.hasAttribute('aria-rowcount')).toBe(false)
    expect(mounted.root.querySelector('.kui-table-wrap')?.hasAttribute('data-virtual')).toBe(false)
  })
})

describe('Table with exportable', () => {
  test('downloads the rows the filter keeps, in the sort on screen, as CSV with a formula escaped', async () => {
    const saved: { blob: Blob, name: string }[] = []
    const spies = [
      spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => `blob:${saved.push({ blob: blob as Blob, name: '' })}`),
      spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined),
      spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        saved.at(-1)!.name = this.download
      }),
    ]

    try {
      mounted = await mountComponent('src/components/exportable-table.kay', {})

      const { root } = mounted
      const input = root.querySelector('input[type="search"]') as HTMLInputElement

      click(root.querySelectorAll('th button')[1]!)
      await settle()
      input.value = 'e'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
      click([...root.querySelectorAll('button')].find(button => button.textContent?.includes('Export CSV')) ?? null)
      await settle()

      expect(saved).toHaveLength(1)
      expect(saved[0]?.name).toBe('planets.csv')
      expect(saved[0]?.blob.type).toBe('text/csv;charset=utf-8')
      expect([...new Uint8Array(await saved[0]!.blob.arrayBuffer()).slice(0, 3)]).toEqual([0xEF, 0xBB, 0xBF])
      expect(await saved[0]?.blob.text()).toBe('Name,Moons\r\nVenus,0\r\n\'=Earth,1\r\n')
    }
    finally {
      for (const spy of spies)
        spy.mockRestore()
    }
  })

  test('links an endpoint given as an address, with the sort and the filter text on screen', async () => {
    mounted = await mountComponent('src/components/exportable-table.kay', { exportable: '/planets.csv?team=a', filterParam: 'search' })

    const { root } = mounted
    const input = root.querySelector('input[type="search"]') as HTMLInputElement
    const link = () => root.querySelector('a[download]') as HTMLAnchorElement

    expect(link().getAttribute('href')).toBe('/planets.csv?team=a')
    expect(link().getAttribute('download')).toBe('planets.csv')

    click(root.querySelectorAll('th button')[0]!)
    input.value = 'ma rs'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    expect(link().getAttribute('href')).toBe('/planets.csv?team=a&sort=name&direction=desc&search=ma+rs')
  })

  test('shows no button without it', async () => {
    mounted = await mountComponent('src/components/exportable-table.kay', { exportable: false })

    expect(mounted.root.textContent).not.toContain('Export CSV')
  })
})
