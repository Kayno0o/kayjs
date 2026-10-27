import type { ListFilter, SortState } from '@kaynooo/kayjs-ui'
import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import FilteredTable from '../tests/fixture/src/components/filtered-table.kay'
import ListedTable from '../tests/fixture/src/components/listed-table.kay'
import SelectableFeed from '../tests/fixture/src/components/selectable-feed.kay'
import SelectableTable from '../tests/fixture/src/components/selectable-table.kay'
import TableComponent from '../tests/fixture/src/components/table.kay'
import { click, clock } from './dom'

const PLANETS = [{ id: 1, name: 'Mars', moons: 2 }, { id: 2, name: 'Earth', moons: 1 }, { id: 3, name: 'Venus', moons: 0 }]

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  visit('about:blank')
})

// happy-dom keeps about:blank through history.replaceState, so the page's URL is set through its own handle.
function visit(url: string) {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)
}

const names = (root: HTMLElement) => [...root.querySelectorAll('tbody tr')].map(row => row.querySelector('[data-part="cellBody"]')?.textContent)
const header = (root: HTMLElement, index: number) => root.querySelectorAll('th')[index]!

describe('Table', () => {
  test('sorts by a header click, its default direction first, flipping on the next, with aria-sort following', async () => {
    const sorts: SortState[] = []

    mounted = await mountComponent(TableComponent, { rows: PLANETS, onSort: (sort: SortState) => sorts.push(sort) })

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
    mounted = await mountComponent(TableComponent, { rows: PLANETS })

    expect(mounted.root.querySelector('tbody td strong')?.textContent).toBe('Mars')
    expect(header(mounted.root, 2).querySelector('button')).toBeNull()
  })

  test('leaves rows the data source sorted as they came, showing only the sort in its headers', async () => {
    mounted = await mountComponent(TableComponent, { rows: PLANETS, serverSort: true })
    click(header(mounted.root, 0).querySelector('button'))
    await settle()

    expect(names(mounted.root)).toEqual(['Mars', 'Earth', 'Venus'])
    expect(header(mounted.root, 0).getAttribute('aria-sort')).toBe('ascending')
  })

  test('has no sortable header at all with sortable false, numeric columns included', async () => {
    mounted = await mountComponent(TableComponent, { rows: PLANETS, sortable: false, numericMoons: true, sort: { key: 'moons', direction: 'asc' } })

    expect(mounted.root.querySelectorAll('th button')).toHaveLength(0)
    expect(mounted.root.querySelector('th[aria-sort]')).toBeNull()
    expect(names(mounted.root)).toEqual(['Mars', 'Earth', 'Venus'])
  })

  test('shows its @empty block when there are no rows', async () => {
    mounted = await mountComponent(TableComponent, { rows: [] })

    expect(mounted.root.querySelector('[data-part="emptyCell"]')?.getAttribute('colspan')).toBe('3')
    expect(mounted.root.querySelector('[data-part="emptyCell"] .nothing')?.textContent).toBe('No planets')
  })
})

describe('Table over an infinite list', () => {
  const cells = (root: HTMLElement) => [...root.querySelectorAll('tbody tr')].map(row => row.querySelector('[data-part="cellBody"]')?.textContent)

  test('sorts on the server: a header click reloads the list from offset 0 with the sort and keeps the rows until they land', async () => {
    const asked: { offset: number, sort: SortState | undefined, filter: ListFilter }[] = []
    let answer: ((rows: { id: number, name: string, moons: number }[]) => void) | undefined
    const onLoad = async (at: { offset: number, sort: SortState | undefined, filter: ListFilter }) => new Promise<{ id: number, name: string, moons: number }[]>((resolve) => {
      asked.push(at)
      answer = resolve
    })
    const sorts: SortState[] = []

    mounted = await mountComponent(ListedTable, { onLoad, onSort: (sort: SortState) => sorts.push(sort) })

    const { root } = mounted

    click(header(root, 1).querySelector('button'))
    await settle()

    expect(asked).toEqual([{ offset: 0, sort: { key: 'moons', direction: 'desc' }, filter: { text: '', fields: {} } }])
    expect(sorts).toEqual([{ key: 'moons', direction: 'desc' }])
    expect(cells(root)).toEqual(['Io', 'Europa'])
    expect(header(root, 1).getAttribute('aria-sort')).toBe('descending')

    answer!([{ id: 2, name: 'Europa', moons: 1 }, { id: 1, name: 'Io', moons: 0 }])
    await settle()

    expect(cells(root)).toEqual(['Europa', 'Io'])
  })

  test('sends the sort it starts from to the list, which holds another', async () => {
    const asked: (SortState | undefined)[] = []
    const onLoad = async (at: { sort: SortState | undefined }) => {
      asked.push(at.sort)

      return []
    }

    mounted = await mountComponent(ListedTable, { onLoad, sort: { key: 'name', direction: 'desc' } })
    await settle()

    expect(asked).toEqual([{ key: 'name', direction: 'desc' }])
  })

  test('sends the sort the URL restores to the list, once, from offset 0', async () => {
    const asked: { offset: number, sort: SortState | undefined, filter: ListFilter }[] = []
    const onLoad = async (at: { offset: number, sort: SortState | undefined, filter: ListFilter }) => {
      asked.push(at)

      return []
    }

    visit('http://localhost/?sort=moons&direction=asc')
    mounted = await mountComponent(ListedTable, { onLoad, sortParam: 'sort' })
    await settle()

    expect(asked).toEqual([{ offset: 0, sort: { key: 'moons', direction: 'asc' }, filter: { text: '', fields: {} } }])
    expect(header(mounted.root, 1).getAttribute('aria-sort')).toBe('ascending')
  })

  test('a header click calls sortBy once: one load, one onSort', async () => {
    const asked: (SortState | undefined)[] = []
    const sorts: SortState[] = []
    const onLoad = async (at: { sort: SortState | undefined }) => {
      asked.push(at.sort)

      return []
    }

    mounted = await mountComponent(ListedTable, { onLoad, onSort: (sort: SortState) => sorts.push(sort) })
    click(header(mounted.root, 0).querySelector('button'))
    await settle()
    click(header(mounted.root, 0).querySelector('button'))
    await settle()

    expect(asked).toEqual([{ key: 'name', direction: 'asc' }, { key: 'name', direction: 'desc' }])
    expect(sorts).toEqual(asked as SortState[])
  })

  describe('filtering on the server', () => {
    const FIELDS = [{ key: 'origin', label: 'Origin', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }, { key: 'tag', label: 'Tag' }]
    const asked: { offset: number, sort: SortState | undefined, filter: ListFilter }[] = []
    const onLoad = async (at: { offset: number, sort: SortState | undefined, filter: ListFilter }) => {
      asked.push(at)

      return []
    }

    afterEach(() => {
      clock.stop()
      asked.length = 0
    })

    test('the typed text reaches the list after a pause in typing, from offset 0, and the loaded rows are not filtered again', async () => {
      mounted = await mountComponent(ListedTable, { onLoad, searchable: true })
      await settle()
      clock.start()

      const input = mounted.root.querySelector<HTMLInputElement>('[data-part="filterInput"]')!

      input.value = 'eur'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await clock.elapse(100)

      expect(asked).toEqual([])
      expect(cells(mounted.root)).toEqual(['Io', 'Europa'])

      await clock.elapse(300)

      expect(asked).toEqual([{ offset: 0, sort: undefined, filter: { text: 'eur', fields: {} } }])
      expect(mounted.root.querySelector('[data-part="count"]')?.textContent).toBe('0 rows')
      expect(mounted.root.querySelector('.no-match')).not.toBeNull()
    })

    test('extra fields join the text, one load for a change of several, and keep the URL', async () => {
      visit('http://localhost/?q=io&origin=b&sort=moons&direction=asc')
      mounted = await mountComponent(ListedTable, { onLoad, searchable: true, filterParam: 'q', sortParam: 'sort', fields: FIELDS })
      await settle()

      expect(asked).toEqual([{ offset: 0, sort: { key: 'moons', direction: 'asc' }, filter: { text: 'io', fields: { origin: 'b' } } }])

      clock.start()

      const select = mounted.root.querySelector<HTMLSelectElement>('select')!
      const tag = mounted.root.querySelectorAll<HTMLInputElement>('input[type="search"]')[1]!

      select.value = 'a'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      tag.value = 'x'
      tag.dispatchEvent(new Event('input', { bubbles: true }))
      await clock.elapse(400)

      expect(asked).toHaveLength(2)
      expect(asked[1]).toEqual({ offset: 0, sort: { key: 'moons', direction: 'asc' }, filter: { text: 'io', fields: { origin: 'a', tag: 'x' } } })
      expect(window.location.search).toContain('origin=a')
      expect(window.location.search).toContain('tag=x')
    })

    test('a sort clicked while typed text waits for its pause loads at once, with the text', async () => {
      mounted = await mountComponent(ListedTable, { onLoad, searchable: true })
      await settle()
      clock.start()

      const input = mounted.root.querySelector<HTMLInputElement>('[data-part="filterInput"]')!

      input.value = 'eur'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await clock.elapse(50)
      click(header(mounted.root, 0).querySelector('button'))
      await clock.elapse(0)

      expect(asked).toEqual([{ offset: 0, sort: { key: 'name', direction: 'asc' }, filter: { text: 'eur', fields: {} } }])

      await clock.elapse(400)

      expect(asked).toHaveLength(1)
    })

    test('text typed back to what the list holds before the pause loads nothing', async () => {
      mounted = await mountComponent(ListedTable, { onLoad, searchable: true })
      await settle()
      clock.start()

      const input = mounted.root.querySelector<HTMLInputElement>('[data-part="filterInput"]')!

      input.value = 'e'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await clock.elapse(100)
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await clock.elapse(400)

      expect(asked).toEqual([])
    })

    test('a field keyed by a name the table writes in the query is refused', async () => {
      for (const key of ['q', 'sort', 'direction', 'order', 'orderDirection'])
        await expect(mountComponent(ListedTable, { onLoad, searchable: true, sortParam: 'order', fields: [{ key, label: 'Clash' }] })).rejects.toThrow(`a Table field cannot be keyed ${key}`)
    })

    test('a filterParam alone shows the search box of a table over a list', async () => {
      mounted = await mountComponent(ListedTable, { onLoad, filterParam: 'q' })

      expect(mounted.root.querySelector('[data-part="filterInput"]')).not.toBeNull()
    })

    test('a table whose filter equals the one its list began with loads nothing on mount', async () => {
      mounted = await mountComponent(ListedTable, { onLoad, searchable: true, filterParam: 'q', fields: FIELDS })
      await settle()

      expect(asked).toEqual([])
    })
  })

  test('draws LoadMore after the rows', async () => {
    mounted = await mountComponent(ListedTable, { onLoad: async () => [] })

    expect(mounted.root.querySelector('.kui-load-more')).not.toBeNull()
  })
})

describe('Table with a filter', () => {
  const MOONS = [{ name: 'Phobos', planet: 'Mars', radius: 11 }, { name: 'Deimos', planet: 'Mars', radius: 6 }, { name: 'Io', planet: 'Jupiter', radius: 1822 }]

  function filter(root: HTMLElement, text: string) {
    const input = root.querySelector<HTMLInputElement>('[data-part="filterInput"]')!

    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  test('draws the columns through @cell without cell: true, a numeric one sorting largest first and a cell: false one as text', async () => {
    mounted = await mountComponent(FilteredTable, { rows: MOONS })

    const cells = (row: number) => [...mounted!.root.querySelectorAll('tbody tr')[row]!.querySelectorAll('[data-part="cellBody"]')].map(cell => cell.innerHTML.replaceAll(/<!--[^>]*-->/g, ''))

    expect(cells(0)).toEqual(['<strong>Phobos</strong>', 'Mars', '11 km'])
    expect(header(mounted.root, 2).getAttribute('data-align')).toBe('end')
    expect(mounted.root.querySelectorAll('tbody td')[2]!.hasAttribute('data-numeric')).toBe(true)

    click(header(mounted.root, 2).querySelector('button'))
    await settle()

    expect(names(mounted.root).map(name => name?.replaceAll(/<!--[^>]*-->/g, ''))).toEqual(['Io', 'Phobos', 'Deimos'])
  })

  test('keeps the rows whose named fields hold the typed text, whatever its case, says how many to screen readers, and when none does', async () => {
    mounted = await mountComponent(FilteredTable, { rows: MOONS })

    expect(mounted.root.querySelector('[data-part="filter"]')?.textContent).toBe('Filter moons')

    filter(mounted.root, ' mars ')
    await settle()

    expect(names(mounted.root)).toEqual(['Phobos', 'Deimos'])
    expect(mounted.root.querySelector('.kui-table-wrap > [role="status"]')?.textContent).toBe('2 rows')

    filter(mounted.root, 'titan')
    await settle()

    expect(mounted.root.querySelector('[data-part="emptyCell"] .no-match')?.textContent).toBe('No moon matches')

    filter(mounted.root, '')
    await settle()

    expect(names(mounted.root)).toHaveLength(3)
    expect(mounted.root.querySelector('.kui-table-wrap > [role="status"]')?.textContent).toBe('')
  })

  test('keeps the typed text in the URL under filterParam, and starts from it', async () => {
    visit('http://localhost/?q=io')
    mounted = await mountComponent(FilteredTable, { rows: MOONS, filterParam: 'q' })

    expect(names(mounted.root)).toEqual(['Io'])
    expect(mounted.root.querySelector<HTMLInputElement>('[data-part="filterInput"]')?.value).toBe('io')

    filter(mounted.root, 'deim')
    await settle()

    expect(location.search).toBe('?q=deim')
    visit('about:blank')
  })

  test('keeps the sort a header click picks in the URL under sortParam, replacing the entry, and starts from it', async () => {
    visit('http://localhost/?sort=name&direction=desc')
    const before = history.length

    mounted = await mountComponent(FilteredTable, { rows: MOONS, sortParam: 'sort' })

    expect(names(mounted.root)).toEqual(['Phobos', 'Io', 'Deimos'])
    expect(header(mounted.root, 0).getAttribute('aria-sort')).toBe('descending')

    click(header(mounted.root, 0).querySelector('button'))
    await settle()
    // Both params go through the one throttled write, the second landing after its gap.
    await new Promise(resolve => setTimeout(resolve, 300))

    expect(location.search).toBe('?sort=name&direction=asc')
    expect(history.length).toBe(before)
    visit('about:blank')
  })

  test('ignores a sort in the URL naming no sortable column', async () => {
    visit('http://localhost/?sort=planet&direction=desc')
    mounted = await mountComponent(FilteredTable, { rows: MOONS, sortParam: 'sort' })

    expect(mounted.root.querySelector('th[aria-sort]')).toBeNull()
    visit('about:blank')
  })

  test('shows its @empty block, not the no-match one, when there are no rows at all', async () => {
    mounted = await mountComponent(FilteredTable, { rows: [] })

    expect(mounted.root.querySelector('[data-part="emptyCell"] .nothing')?.textContent).toBe('No moons')
  })
})

describe('Table with a selection', () => {
  const MOONS = [{ id: 1, name: 'Io', radius: 1822 }, { id: 2, name: 'Europa', radius: 1561 }, { id: 3, name: 'Amalthea', radius: 84 }]
  const boxes = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>('tbody .kui-checkbox [data-part="input"]')]
  const all = (root: HTMLElement) => root.querySelector<HTMLInputElement>('[data-part="selection"] .kui-checkbox [data-part="input"]')!
  const toolbar = (root: HTMLElement) => root.querySelector('[data-part="selection"]')!.textContent
  const ticked = (root: HTMLElement) => boxes(root).map(box => box.checked)

  function toggle(box: HTMLInputElement) {
    box.checked = !box.checked
    box.dispatchEvent(new Event('change', { bubbles: true }))
  }

  test('draws no box without `selectable`', async () => {
    mounted = await mountComponent(TableComponent, { rows: PLANETS })

    expect(mounted.root.querySelector('.kui-checkbox, [data-part="selection"]')).toBeNull()
  })

  test('picks rows, counts them, and shows the select-all box unticked, indeterminate for some and ticked for all', async () => {
    const seen: unknown[][] = []

    mounted = await mountComponent(SelectableTable, { rows: MOONS, onSelect: (keys: unknown[]) => seen.push(keys) })

    const { root } = mounted

    expect(toolbar(root)).toBe('Select all')
    expect(all(root).indeterminate).toBe(false)
    expect(root.querySelector('[data-part="bulk"]')).toBeNull()

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

    mounted = await mountComponent(SelectableTable, { rows: MOONS, onSelect: (keys: unknown[]) => seen.push(keys) })
    toggle(boxes(mounted.root)[2]!)
    await settle()
    toggle(boxes(mounted.root)[0]!)
    await settle()

    expect(seen).toEqual([[3], [1, 3]])
  })

  test('hands the picked rows beside the keys, in the rows\' order', async () => {
    const seen: unknown[][] = []

    mounted = await mountComponent(SelectableTable, { rows: MOONS, onSelect: (keys: unknown[], rows: unknown[]) => seen.push([keys, rows]) })
    toggle(boxes(mounted.root)[2]!)
    await settle()
    toggle(boxes(mounted.root)[0]!)
    await settle()

    expect(seen.at(-1)).toEqual([[1, 3], [MOONS[0], MOONS[2]]])
  })

  test('keeps the bulk block mounted when the rows are replaced by others with the same keys', async () => {
    mounted = await mountComponent(SelectableTable, { rows: MOONS, selected: [1] })
    await settle()

    const action = mounted.root.querySelector('.bulk-action')

    click(mounted.root.querySelector('.same'))
    await settle()

    expect(mounted.root.querySelector('.bulk-action')).toBe(action)
  })

  test('selects every row from select-all, and clears them from it once all are picked, and from the indeterminate state selects all', async () => {
    mounted = await mountComponent(SelectableTable, { rows: MOONS })

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

    mounted = await mountComponent(SelectableTable, { rows: MOONS, onBulk: (keys: unknown[]) => acted.push(keys) })

    const { root } = mounted

    toggle(boxes(root)[2]!)
    toggle(boxes(root)[0]!)
    await settle()
    click(root.querySelector('[data-part="selection"] .bulk-action'))
    await settle()

    expect(acted).toEqual([[1, 3]])
    expect(ticked(root)).toEqual([false, false, false])
    expect(root.querySelector('[data-part="bulk"]')).toBeNull()
  })

  test('labels each row box by its row, the select-all box and the column header, and takes the texts from the page', async () => {
    mounted = await mountComponent(SelectableTable, { rows: MOONS })

    const { root } = mounted

    expect(boxes(root).map(box => box.getAttribute('aria-label'))).toEqual(['Select Io', 'Select Europa', 'Select Amalthea'])
    expect(header(root, 0).textContent).toBe('Select all')
    mounted.unmount()

    mounted = await mountComponent(SelectableTable, { rows: MOONS, selected: [1, 2], selectAllLabel: 'Tout', selectedLabel: (count: number) => `${count} choisis`, selectRowLabel: (row: { name: string }) => `Choisir ${row.name}` })

    expect(toolbar(mounted.root)).toContain('2 choisis')
    expect(header(mounted.root, 0).textContent).toBe('Tout')
    expect(boxes(mounted.root).map(box => box.getAttribute('aria-label'))).toEqual(['Choisir Io', 'Choisir Europa', 'Choisir Amalthea'])
  })

  test('starts from `selected` and drops keys of rows that are not there, telling the page', async () => {
    const seen: unknown[][] = []

    mounted = await mountComponent(SelectableTable, { rows: MOONS, selected: [3, 9, 1], onSelect: (keys: unknown[]) => seen.push(keys) })
    await settle()

    expect(ticked(mounted.root)).toEqual([true, false, true])
    expect(toolbar(mounted.root)).toContain('2 selected')
    expect(seen).toEqual([[1, 3]])
  })

  test('prunes the keys of rows no longer in `rows`, and a row coming back is not picked again', async () => {
    const seen: unknown[][] = []

    mounted = await mountComponent(SelectableTable, { rows: MOONS, selected: [1, 2, 3], onSelect: (keys: unknown[]) => seen.push(keys) })
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
    mounted = await mountComponent(SelectableTable, { rows: MOONS })

    const { root } = mounted

    toggle(boxes(root)[0]!)
    await settle()
    click(header(root, 1).querySelector('button'))
    await settle()

    expect(boxes(root).map(box => box.getAttribute('aria-label'))).toEqual(['Select Amalthea', 'Select Europa', 'Select Io'])
    expect(ticked(root)).toEqual([false, false, true])
  })

  test('select-all acts on the rows the filter shows, leaving the ones it hides as they are', async () => {
    mounted = await mountComponent(SelectableTable, { rows: MOONS, filter: true, selected: [3] })

    const { root } = mounted
    const input = root.querySelector<HTMLInputElement>('[data-part="filterInput"]')!

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
    mounted = await mountComponent(SelectableTable, { rows: [] })

    expect(all(mounted.root).disabled).toBe(true)
    expect(mounted.root.querySelector('[data-part="emptyCell"]')?.getAttribute('colspan')).toBe('3')
  })

  test('keeps the select-all box outside the table, so stacked cards have it too, and a box in each card without a label', async () => {
    mounted = await mountComponent(SelectableTable, { rows: MOONS, narrow: 'stack' })

    const { root } = mounted

    expect(root.querySelector('table [data-part="selection"]')).toBeNull()
    expect(root.querySelector('tbody tr td[data-part="selectCell"] [data-part="cellLabel"]')).toBeNull()
  })

  test('works with the rows of an infinite list: a page loaded later joins select-all and the picked rows stay picked', async () => {
    const seen: unknown[][] = []

    mounted = await mountComponent(SelectableFeed, { onLoad: async () => [{ id: 3, name: 'Amalthea' }], onSelect: (keys: unknown[]) => seen.push(keys) })

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
