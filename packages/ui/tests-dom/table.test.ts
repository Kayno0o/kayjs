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

const names = (root: HTMLElement) => [...root.querySelectorAll('tbody tr')].map(row => row.querySelector('td')?.textContent)
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

    expect(mounted.root.querySelector('.table-empty-cell')?.getAttribute('colspan')).toBe('3')
    expect(mounted.root.querySelector('.table-empty-cell .nothing')?.textContent).toBe('No planets')
  })
})
