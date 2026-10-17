import type { SortState } from '@kaynooo/kayjs-ui'
import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
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

    mounted = await mountComponent('src/components/table.kay', { rows: PLANETS, onSort: (sort: SortState) => sorts.push(sort) })

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
    mounted = await mountComponent('src/components/table.kay', { rows: PLANETS })

    expect(mounted.root.querySelector('tbody td strong')?.textContent).toBe('Mars')
    expect(header(mounted.root, 2).querySelector('button')).toBeNull()
  })

  test('leaves rows the data source sorted as they came, showing only the sort in its headers', async () => {
    mounted = await mountComponent('src/components/table.kay', { rows: PLANETS, serverSort: true })
    click(header(mounted.root, 0).querySelector('button'))
    await settle()

    expect(names(mounted.root)).toEqual(['Mars', 'Earth', 'Venus'])
    expect(header(mounted.root, 0).getAttribute('aria-sort')).toBe('ascending')
  })

  test('shows its @empty block when there are no rows', async () => {
    mounted = await mountComponent('src/components/table.kay', { rows: [] })

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
    mounted = await mountComponent('src/components/filtered-table.kay', { rows: MOONS })

    const cells = (row: number) => [...mounted!.root.querySelectorAll('tbody tr')[row]!.querySelectorAll('.kui-table-cell-body')].map(cell => cell.innerHTML.replaceAll(/<!--[^>]*-->/g, ''))

    expect(cells(0)).toEqual(['<strong>Phobos</strong>', 'Mars', '11 km'])
    expect(header(mounted.root, 2).getAttribute('data-align')).toBe('end')
    expect(mounted.root.querySelectorAll('tbody td')[2]!.hasAttribute('data-numeric')).toBe(true)

    click(header(mounted.root, 2).querySelector('button'))
    await settle()

    expect(names(mounted.root).map(name => name?.replaceAll(/<!--[^>]*-->/g, ''))).toEqual(['Io', 'Phobos', 'Deimos'])
  })

  test('keeps the rows whose named fields hold the typed text, whatever its case, says how many to screen readers, and when none does', async () => {
    mounted = await mountComponent('src/components/filtered-table.kay', { rows: MOONS })

    expect(mounted.root.querySelector('.kui-table-filter')?.textContent).toBe('Filter moons')

    filter(mounted.root, ' mars ')
    await settle()

    expect(names(mounted.root)).toEqual(['Phobos', 'Deimos'])
    expect(mounted.root.querySelector('.kui-table-wrap > [role="status"]')?.textContent).toBe('2 rows')

    filter(mounted.root, 'titan')
    await settle()

    expect(mounted.root.querySelector('.kui-table-empty-cell .no-match')?.textContent).toBe('No moon matches')

    filter(mounted.root, '')
    await settle()

    expect(names(mounted.root)).toHaveLength(3)
    expect(mounted.root.querySelector('.kui-table-wrap > [role="status"]')?.textContent).toBe('')
  })

  test('keeps the typed text in the URL under filterParam, and starts from it', async () => {
    visit('http://localhost/?q=io')
    mounted = await mountComponent('src/components/filtered-table.kay', { rows: MOONS, filterParam: 'q' })

    expect(names(mounted.root)).toEqual(['Io'])
    expect(mounted.root.querySelector<HTMLInputElement>('.kui-table-filter-input')?.value).toBe('io')

    filter(mounted.root, 'deim')
    await settle()

    expect(location.search).toBe('?q=deim')
    visit('about:blank')
  })

  test('shows its @empty block, not the no-match one, when there are no rows at all', async () => {
    mounted = await mountComponent('src/components/filtered-table.kay', { rows: [] })

    expect(mounted.root.querySelector('.kui-table-empty-cell .nothing')?.textContent).toBe('No moons')
  })
})

describe('Table with a selection', () => {
  const MOONS = [{ id: 1, name: 'Io', radius: 1822 }, { id: 2, name: 'Europa', radius: 1561 }, { id: 3, name: 'Amalthea', radius: 84 }]
  const boxes = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>('tbody .kui-checkbox-input')]
  const all = (root: HTMLElement) => root.querySelector<HTMLInputElement>('.kui-table-selection .kui-checkbox-input')!
  const toolbar = (root: HTMLElement) => root.querySelector('.kui-table-selection')!.textContent
  const ticked = (root: HTMLElement) => boxes(root).map(box => box.checked)

  function toggle(box: HTMLInputElement) {
    box.checked = !box.checked
    box.dispatchEvent(new Event('change', { bubbles: true }))
  }

  test('draws no box without `selectable`', async () => {
    mounted = await mountComponent('src/components/table.kay', { rows: PLANETS })

    expect(mounted.root.querySelector('.kui-checkbox, .kui-table-selection')).toBeNull()
  })

  test('picks rows, counts them, and shows the select-all box unticked, indeterminate for some and ticked for all', async () => {
    const seen: unknown[][] = []

    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS, onSelect: (keys: unknown[]) => seen.push(keys) })

    const { root } = mounted

    expect(toolbar(root)).toBe('Select all')
    expect(all(root).indeterminate).toBe(false)
    expect(root.querySelector('.kui-table-bulk')).toBeNull()

    toggle(boxes(root)[1]!)
    await settle()

    expect(toolbar(root)).toContain('1 selected')
    expect(ticked(root)).toEqual([false, true, false])
    expect(all(root).indeterminate).toBe(true)
    expect(all(root).checked).toBe(false)

    toggle(boxes(root)[0]!)
    toggle(boxes(root)[2]!)
    await settle()

    expect(toolbar(root)).toContain('3 selected')
    expect(all(root).checked).toBe(true)
    expect(all(root).indeterminate).toBe(false)
    expect(seen.at(-1)).toEqual([1, 2, 3])
  })

  test('hands the keys in the rows\' order whatever the order they were picked in', async () => {
    const seen: unknown[][] = []

    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS, onSelect: (keys: unknown[]) => seen.push(keys) })
    toggle(boxes(mounted.root)[2]!)
    await settle()
    toggle(boxes(mounted.root)[0]!)
    await settle()

    expect(seen).toEqual([[3], [1, 3]])
  })

  test('keeps the bulk block mounted when the rows are replaced by others with the same keys', async () => {
    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS, selected: [1] })
    await settle()

    const action = mounted.root.querySelector('.bulk-action')

    click(mounted.root.querySelector('.same'))
    await settle()

    expect(mounted.root.querySelector('.bulk-action')).toBe(action)
  })

  test('selects every row from select-all, and clears them from it once all are picked, and from the indeterminate state selects all', async () => {
    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS })

    const { root } = mounted

    toggle(boxes(root)[0]!)
    await settle()
    toggle(all(root))
    await settle()

    expect(ticked(root)).toEqual([true, true, true])

    toggle(all(root))
    await settle()

    expect(ticked(root)).toEqual([false, false, false])
    expect(toolbar(root)).toBe('Select all')
  })

  test('shows the bulk block beside the count with the keys in row order, and its clear function empties the selection', async () => {
    const acted: unknown[][] = []

    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS, onBulk: (keys: unknown[]) => acted.push(keys) })

    const { root } = mounted

    toggle(boxes(root)[2]!)
    toggle(boxes(root)[0]!)
    await settle()
    click(root.querySelector('.kui-table-selection .bulk-action'))
    await settle()

    expect(acted).toEqual([[1, 3]])
    expect(ticked(root)).toEqual([false, false, false])
    expect(root.querySelector('.kui-table-bulk')).toBeNull()
  })

  test('labels each row box by its row, the select-all box and the column header, and takes the texts from the page', async () => {
    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS })

    const { root } = mounted

    expect(boxes(root).map(box => box.getAttribute('aria-label'))).toEqual(['Select Io', 'Select Europa', 'Select Amalthea'])
    expect(header(root, 0).textContent).toBe('Select all')
    mounted.unmount()

    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS, selected: [1, 2], selectAllLabel: 'Tout', selectedLabel: (count: number) => `${count} choisis`, selectRowLabel: (row: { name: string }) => `Choisir ${row.name}` })

    expect(toolbar(mounted.root)).toContain('2 choisis')
    expect(header(mounted.root, 0).textContent).toBe('Tout')
    expect(boxes(mounted.root).map(box => box.getAttribute('aria-label'))).toEqual(['Choisir Io', 'Choisir Europa', 'Choisir Amalthea'])
  })

  test('starts from `selected` and drops keys of rows that are not there, telling the page', async () => {
    const seen: unknown[][] = []

    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS, selected: [3, 9, 1], onSelect: (keys: unknown[]) => seen.push(keys) })
    await settle()

    expect(ticked(mounted.root)).toEqual([true, false, true])
    expect(toolbar(mounted.root)).toContain('2 selected')
    expect(seen).toEqual([[1, 3]])
  })

  test('prunes the keys of rows no longer in `rows`, and a row coming back is not picked again', async () => {
    const seen: unknown[][] = []

    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS, selected: [1, 2, 3], onSelect: (keys: unknown[]) => seen.push(keys) })
    await settle()
    click(mounted.root.querySelector('.drop'))
    await settle()

    expect(toolbar(mounted.root)).toContain('2 selected')
    expect(seen.at(-1)).toEqual([1, 3])

    click(mounted.root.querySelector('.restore'))
    await settle()

    expect(ticked(mounted.root)).toEqual([true, false, true])
  })

  test('keeps the selection through a sort', async () => {
    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS })

    const { root } = mounted

    toggle(boxes(root)[0]!)
    await settle()
    click(header(root, 1).querySelector('button'))
    await settle()

    expect(boxes(root).map(box => box.getAttribute('aria-label'))).toEqual(['Select Amalthea', 'Select Europa', 'Select Io'])
    expect(ticked(root)).toEqual([false, false, true])
  })

  test('select-all acts on the rows the filter shows, leaving the ones it hides as they are', async () => {
    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS, filter: true, selected: [3] })

    const { root } = mounted
    const input = root.querySelector<HTMLInputElement>('.kui-table-filter-input')!

    input.value = 'eur'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    expect(boxes(root)).toHaveLength(1)
    expect(all(root).indeterminate).toBe(false)
    expect(all(root).checked).toBe(false)

    toggle(all(root))
    await settle()

    expect(toolbar(root)).toContain('2 selected')
    expect(all(root).checked).toBe(true)

    toggle(all(root))
    await settle()

    expect(toolbar(root)).toContain('1 selected')

    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    expect(ticked(root)).toEqual([false, false, true])
  })

  test('disables select-all for an empty table and gives the empty cell the extra column', async () => {
    mounted = await mountComponent('src/components/selectable-table.kay', { rows: [] })

    expect(all(mounted.root).disabled).toBe(true)
    expect(mounted.root.querySelector('.kui-table-empty-cell')?.getAttribute('colspan')).toBe('3')
  })

  test('keeps the select-all box outside the table, so stacked cards have it too, and a box in each card without a label', async () => {
    mounted = await mountComponent('src/components/selectable-table.kay', { rows: MOONS, narrow: 'stack' })

    const { root } = mounted

    expect(root.querySelector('table .kui-table-selection')).toBeNull()
    expect(root.querySelector('tbody tr td.kui-table-select-cell .kui-table-cell-label')).toBeNull()
  })

  test('works with the rows of an infinite list: a page loaded later joins select-all and the picked rows stay picked', async () => {
    const seen: unknown[][] = []

    mounted = await mountComponent('src/components/selectable-feed.kay', { onLoad: async () => [{ id: 3, name: 'Amalthea' }], onSelect: (keys: unknown[]) => seen.push(keys) })

    const { root } = mounted

    toggle(boxes(root)[0]!)
    await settle()
    click(root.querySelector('.more'))
    await settle()

    expect(boxes(root)).toHaveLength(3)
    expect(ticked(root)).toEqual([true, false, false])

    toggle(all(root))
    await settle()

    expect(toolbar(root)).toContain('3 selected')
    expect(seen.at(-1)).toEqual([1, 2, 3])
  })
})
