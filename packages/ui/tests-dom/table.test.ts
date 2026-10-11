import type { SortState } from '@kaynooo/kayjs-ui'
import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

const PLANETS = [{ id: 1, name: 'Mars', moons: 2 }, { id: 2, name: 'Earth', moons: 1 }, { id: 3, name: 'Venus', moons: 0 }]

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

const names = (root: HTMLElement) => [...root.querySelectorAll('tbody tr')].map(row => row.querySelector('.kui-table-cell-body')?.textContent)
const header = (root: HTMLElement, index: number) => root.querySelectorAll('th')[index]!

describe('Table', () => {
  test('sorts by a header click, its default direction first, flipping on the next, with aria-sort following', async () => {
    const sorts: SortState[] = []

    mounted = await mount('src/components/table.kay', { rows: PLANETS, onSort: (sort: SortState) => sorts.push(sort) })

    const { root } = mounted

    expect(names(root)).toEqual(['Mars', 'Earth', 'Venus'])

    click(header(root, 0).querySelector('button'))
    await settle()

    expect(names(root)).toEqual(['Earth', 'Mars', 'Venus'])
    expect(header(root, 0).getAttribute('aria-sort')).toBe('ascending')

    click(header(root, 1).querySelector('button'))
    await settle()

    expect(names(root)).toEqual(['Mars', 'Earth', 'Venus'])
    expect(header(root, 0).getAttribute('aria-sort')).toBeNull()
    expect(header(root, 1).getAttribute('aria-sort')).toBe('descending')

    click(header(root, 1).querySelector('button'))
    await settle()

    expect(names(root)).toEqual(['Venus', 'Earth', 'Mars'])
    expect(sorts).toEqual([{ key: 'name', direction: 'asc' }, { key: 'moons', direction: 'desc' }, { key: 'moons', direction: 'asc' }])
  })

  test('draws the cells of a `cell: true` column through its @cell block, and never sorts a column without sortValue', async () => {
    mounted = await mount('src/components/table.kay', { rows: PLANETS })

    expect(mounted.root.querySelector('tbody td strong')?.textContent).toBe('Mars')
    expect(header(mounted.root, 2).querySelector('button')).toBeNull()
  })

  test('leaves rows the data source sorted as they came, showing only the sort in its headers', async () => {
    mounted = await mount('src/components/table.kay', { rows: PLANETS, serverSort: true })
    click(header(mounted.root, 0).querySelector('button'))
    await settle()

    expect(names(mounted.root)).toEqual(['Mars', 'Earth', 'Venus'])
    expect(header(mounted.root, 0).getAttribute('aria-sort')).toBe('ascending')
  })

  test('shows its @empty block when there are no rows', async () => {
    mounted = await mount('src/components/table.kay', { rows: [] })

    expect(mounted.root.querySelector('.kui-table-empty-cell')?.getAttribute('colspan')).toBe('3')
    expect(mounted.root.querySelector('.kui-table-empty-cell .nothing')?.textContent).toBe('No planets')
  })
})

describe('Table with a filter', () => {
  const MOONS = [{ name: 'Phobos', planet: 'Mars', radius: 11 }, { name: 'Deimos', planet: 'Mars', radius: 6 }, { name: 'Io', planet: 'Jupiter', radius: 1822 }]

  // happy-dom keeps about:blank through history.replaceState, so the page's URL is set through its own handle.
  function visit(url: string) {
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)
  }

  function filter(root: HTMLElement, text: string) {
    const input = root.querySelector<HTMLInputElement>('.kui-table-filter-input')!

    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  test('draws the columns through @cell without cell: true, a numeric one sorting largest first and a cell: false one as text', async () => {
    mounted = await mount('src/components/filtered-table.kay', { rows: MOONS })

    const cells = (row: number) => [...mounted!.root.querySelectorAll('tbody tr')[row]!.querySelectorAll('.kui-table-cell-body')].map(cell => cell.innerHTML.replaceAll(/<!--[^>]*-->/g, ''))

    expect(cells(0)).toEqual(['<strong>Phobos</strong>', 'Mars', '11 km'])
    expect(header(mounted.root, 2).getAttribute('data-align')).toBe('end')
    expect(mounted.root.querySelectorAll('tbody td')[2]!.hasAttribute('data-numeric')).toBe(true)

    click(header(mounted.root, 2).querySelector('button'))
    await settle()

    expect(names(mounted.root).map(name => name?.replaceAll(/<!--[^>]*-->/g, ''))).toEqual(['Io', 'Phobos', 'Deimos'])
  })

  test('keeps the rows whose named fields hold the typed text, whatever its case, and says when none does', async () => {
    mounted = await mount('src/components/filtered-table.kay', { rows: MOONS })

    expect(mounted.root.querySelector('.kui-table-filter')?.textContent).toBe('Filter moons')

    filter(mounted.root, ' mars ')
    await settle()

    expect(names(mounted.root)).toEqual(['Phobos', 'Deimos'])

    filter(mounted.root, 'titan')
    await settle()

    expect(mounted.root.querySelector('.kui-table-empty-cell .no-match')?.textContent).toBe('No moon matches')

    filter(mounted.root, '')
    await settle()

    expect(names(mounted.root)).toHaveLength(3)
  })

  test('keeps the typed text in the URL under filterParam, and starts from it', async () => {
    visit('http://localhost/?q=io')
    mounted = await mount('src/components/filtered-table.kay', { rows: MOONS, filterParam: 'q' })

    expect(names(mounted.root)).toEqual(['Io'])
    expect(mounted.root.querySelector<HTMLInputElement>('.kui-table-filter-input')?.value).toBe('io')

    filter(mounted.root, 'deim')
    await settle()

    expect(location.search).toBe('?q=deim')
    visit('about:blank')
  })

  test('shows its @empty block, not the no-match one, when there are no rows at all', async () => {
    mounted = await mount('src/components/filtered-table.kay', { rows: [] })

    expect(mounted.root.querySelector('.kui-table-empty-cell .nothing')?.textContent).toBe('No moons')
  })
})
