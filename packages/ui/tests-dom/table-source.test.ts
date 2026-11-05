import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { signal } from 'kay'
import { mountComponent, settle } from 'kay/test'
import { infiniteList } from '../src/infinite-list'
import BrokenTable from '../tests/fixture/src/components/broken-table.kay'
import { click, library } from './dom'

interface Planet {
  id: number
  name: string
}

const PLANETS: Planet[] = [{ id: 1, name: 'Mars' }, { id: 2, name: 'Earth' }]
const COLUMNS = [{ key: 'name', header: 'Name' }]

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

const Table = await library('table')
const VirtualList = await library('virtual-list')
const names = (root: HTMLElement) => [...root.querySelectorAll('tbody [data-part="row"] [data-part="cellBody"]')].map(cell => cell.textContent)
const skeletons = (root: HTMLElement) => root.querySelectorAll('[data-part="skeletonRow"]').length

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

describe('Table rows from a source', () => {
  test('draws skeleton rows while a promise is on its way, then its rows, onLoad hearing them', async () => {
    const wait = deferred<Planet[]>()
    const loaded: Planet[][] = []

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: wait.promise, rowKey: 'id', skeletonRows: 3, onLoad: (rows: Planet[]) => loaded.push(rows) })

    const { root } = mounted

    expect(skeletons(root)).toBe(3)
    expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true')
    expect(root.querySelector('[data-part="status"]')?.textContent).toBe('Loading…')

    wait.resolve(PLANETS)
    await settle()

    expect(skeletons(root)).toBe(0)
    expect(names(root)).toEqual(['Mars', 'Earth'])
    expect(root.querySelector('table')?.getAttribute('aria-busy')).toBeNull()
    expect(loaded).toEqual([PLANETS])
  })

  test('draws a failure row for a rejected function, onError hearing it, and retry calls the function again', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined)
    const errors: unknown[] = []
    let calls = 0
    const rows = async () => {
      calls++

      if (calls === 1)
        throw new Error('down')

      return PLANETS
    }

    mounted = await mountComponent(Table, { columns: COLUMNS, rows, rowKey: 'id', onError: ({ error }: { error: unknown }) => errors.push(error) })
    await settle()

    const { root } = mounted

    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Could not load the rows.')
    expect((errors[0] as Error).message).toBe('down')

    click(root.querySelector('[role="alert"] button'))
    await settle()

    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(names(root)).toEqual(['Mars', 'Earth'])
    quiet.mockRestore()
  })

  test('offers no retry for a rejected promise, which cannot be asked twice', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined)
    const wait = deferred<Planet[]>()

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: wait.promise, rowKey: 'id' })
    wait.reject(new Error('down'))
    await settle()

    expect(mounted.root.querySelector('[role="alert"]')).not.toBeNull()
    expect(mounted.root.querySelector('[role="alert"] button')).toBeNull()
    quiet.mockRestore()
  })

  test('calls a function that answers an array in the browser, onLoad hearing it', async () => {
    const calls: number[] = []

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: () => {
      calls.push(1)

      return PLANETS
    }, rowKey: 'id', onLoad: (rows: Planet[]) => calls.push(rows.length) })
    await settle()

    expect(names(mounted.root)).toEqual(['Mars', 'Earth'])
    expect(calls).toEqual([1, 2])
    expect(skeletons(mounted.root)).toBe(0)
  })

  test('busy draws skeleton rows over no rows, and dims the rows it has', async () => {
    mounted = await mountComponent(Table, { columns: COLUMNS, rows: [], rowKey: 'id', busy: true })

    expect(skeletons(mounted.root)).toBe(5)
    expect(mounted.root.querySelector('[data-part="emptyCell"]')).toBeNull()
    mounted.unmount()

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: PLANETS, rowKey: 'id', busy: true })

    expect(skeletons(mounted.root)).toBe(0)
    expect(names(mounted.root)).toEqual(['Mars', 'Earth'])
    expect(mounted.root.querySelector('table')?.getAttribute('aria-busy')).toBe('true')
  })
})

describe('Table rows as links and buttons', () => {
  test('rowHref puts a stretched link named after the row in the first cell, ahead of a checkbox and a toggle', async () => {
    mounted = await mountComponent(Table, { columns: COLUMNS, rows: PLANETS, rowKey: 'id', rowHref: (row: Planet) => `/planets/${row.id}`, selectable: true })

    const links = [...mounted.root.querySelectorAll<HTMLAnchorElement>('[data-part="rowLink"]')]

    expect(links.map(link => link.getAttribute('href'))).toEqual(['/planets/1', '/planets/2'])
    expect(links[0]?.getAttribute('aria-label')).toBe('Open Mars')
    expect(mounted.root.querySelector('[data-part="row"]')?.hasAttribute('data-linked')).toBe(true)
    expect(mounted.root.querySelectorAll('[data-part="selectCell"] a')).toHaveLength(0)
  })

  test('onRowClick alone makes each row a button, and a link row hears its click too', async () => {
    const clicked: number[] = []

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: PLANETS, rowKey: 'id', onRowClick: (row: Planet) => clicked.push(row.id) })
    click(mounted.root.querySelectorAll('[data-part="rowButton"]')[1] ?? null)
    expect(clicked).toEqual([2])
    mounted.unmount()

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: PLANETS, rowKey: 'id', rowHref: (row: Planet) => row.id === 1 ? '/one' : undefined, onRowClick: (row: Planet, event: Event) => {
      event.preventDefault()
      clicked.push(row.id * 10)
    } })

    expect(mounted.root.querySelectorAll('[data-part="rowLink"]')).toHaveLength(1)
    expect(mounted.root.querySelectorAll('[data-part="rowButton"]')).toHaveLength(1)
    click(mounted.root.querySelector('[data-part="rowLink"]'))
    expect(clicked).toEqual([2, 10])
  })

  test('openRowLabel names the control', async () => {
    mounted = await mountComponent(Table, { columns: COLUMNS, rows: PLANETS, rowKey: 'id', rowHref: () => '/x', openRowLabel: (row: Planet) => `See ${row.name}` })

    expect(mounted.root.querySelector('[data-part="rowLink"]')?.getAttribute('aria-label')).toBe('See Mars')
  })

  test('draws no link or button without either prop', async () => {
    mounted = await mountComponent(Table, { columns: COLUMNS, rows: PLANETS, rowKey: 'id' })

    expect(mounted.root.querySelector('[data-part="rowLink"], [data-part="rowButton"]')).toBeNull()
    expect(mounted.root.querySelector('[data-part="row"]')?.hasAttribute('data-linked')).toBe(false)
  })
})

describe('VirtualList items from a source', () => {
  const items = (root: HTMLElement) => [...root.querySelectorAll('[data-part="item"]')].map(item => item.textContent)

  test('draws skeletons while a promise is on its way, then its items', async () => {
    const wait = deferred<string[]>()
    const loaded: string[][] = []

    mounted = await mountComponent(VirtualList, { items: wait.promise, label: 'Planets', item: (name: string) => name, skeletonItems: 2, onLoad: (rows: string[]) => loaded.push(rows) })

    expect(mounted.root.querySelectorAll('[data-part="skeleton"]')).toHaveLength(2)
    expect(mounted.root.querySelector('[role="list"]')?.getAttribute('aria-busy')).toBe('true')

    wait.resolve(['Mars', 'Earth'])
    await settle()

    expect(mounted.root.querySelectorAll('[data-part="skeleton"]')).toHaveLength(0)
    expect(items(mounted.root)).toHaveLength(2)
    expect(loaded).toEqual([['Mars', 'Earth']])
  })

  test('shows a failure with a retry for a rejecting function', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined)
    let calls = 0

    mounted = await mountComponent(VirtualList, { items: async () => {
      if (++calls === 1)
        throw new Error('down')

      return ['Mars']
    }, label: 'Planets', item: (name: string) => name })
    await settle()

    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain('Could not load the items.')
    click(mounted.root.querySelector('[role="alert"] button'))
    await settle()

    expect(mounted.root.querySelector('[role="alert"]')).toBeNull()
    expect(items(mounted.root)).toHaveLength(1)
    quiet.mockRestore()
  })

  test('itemHref and onItemClick put a stretched link or button in each item', async () => {
    const clicked: number[] = []

    mounted = await mountComponent(VirtualList, { items: ['Mars', 'Earth'], label: 'Planets', item: (name: string) => name, itemHref: (_: string, index: number) => index === 0 ? '/mars' : undefined, onItemClick: (_: string, index: number) => clicked.push(index) })

    expect(mounted.root.querySelectorAll('[data-part="itemLink"]')).toHaveLength(1)
    expect(mounted.root.querySelector('[data-part="itemLink"]')?.getAttribute('aria-label')).toBe('Open item 1')
    click(mounted.root.querySelector('[data-part="itemButton"]'))
    expect(clicked).toEqual([1])
  })
})

describe('Table over a list', () => {
  test('draw skeletons while the list loads its first page with no rows, and the rows after', async () => {
    const wait = deferred<Planet[]>()
    const feed = infiniteList<Planet>([], { pageSize: 2, load: async () => wait.promise })

    mounted = await mountComponent(Table, { columns: [{ key: 'name', header: 'Name', sortValue: true }], list: feed, rowKey: 'id', sort: { key: 'name', direction: 'asc' } })
    await settle()

    expect(skeletons(mounted.root)).toBe(5)

    wait.resolve(PLANETS)
    await settle()

    expect(skeletons(mounted.root)).toBe(0)
    expect(names(mounted.root)).toEqual(['Mars', 'Earth'])
  })

  test('a failed first page shows LoadMore\'s alert alone, without the empty block, and one loading status', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined)
    const feed = infiniteList<Planet>([], { pageSize: 2, load: async () => {
      throw new Error('down')
    } })

    mounted = await mountComponent(Table, { columns: [{ key: 'name', header: 'Name', sortValue: true }], list: feed, rowKey: 'id', sort: { key: 'name', direction: 'asc' } })
    await settle()

    expect(mounted.root.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(mounted.root.querySelector('[data-part="emptyCell"]')).toBeNull()
    expect(skeletons(mounted.root)).toBe(0)
    quiet.mockRestore()
  })
})

describe('Table over a failing list', () => {
  test('shows the alert alone: no empty block, no noMatch, no skeleton', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined)

    mounted = await mountComponent(BrokenTable, { load: async () => {
      throw new Error('down')
    } })
    await settle()

    expect(mounted.root.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(mounted.root.querySelector('.nothing')).toBeNull()
    expect(mounted.root.querySelector('.no-match')).toBeNull()
    expect(skeletons(mounted.root)).toBe(0)
    quiet.mockRestore()
  })

  test('shows the empty block once a list loaded nothing', async () => {
    mounted = await mountComponent(BrokenTable, { load: async () => [] })
    await settle()

    expect(mounted.root.querySelector('.nothing')).not.toBeNull()
  })
})

describe('Table source callbacks', () => {
  test('a signal read in onLoad does not run the load again', async () => {
    const other = signal(0)
    let calls = 0

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: () => {
      calls++

      return PLANETS
    }, rowKey: 'id', onLoad: () => other() })
    await settle()

    expect(calls).toBe(1)
    other.set(1)
    await settle()

    expect(calls).toBe(1)
  })
})

describe('VirtualList over a list', () => {
  test('keeps its loading status for LoadMore while the list is pending', async () => {
    const wait = deferred<string[]>()
    const feed = infiniteList<string>([], { pageSize: 2, load: async () => wait.promise })

    mounted = await mountComponent(VirtualList, { list: feed, label: 'Planets', item: (name: string) => name })
    void feed.restart({})
    await settle()

    expect(mounted.root.querySelector('[data-part="status"]')?.textContent).toBe('')
    expect(mounted.root.querySelectorAll('[data-part="skeleton"]')).toHaveLength(5)
    wait.resolve([])
  })

  test('keeps one notices listitem with the status mounted before its text', async () => {
    const wait = deferred<string[]>()

    mounted = await mountComponent(VirtualList, { items: wait.promise, label: 'Planets', item: (name: string) => name })

    expect(mounted.root.querySelectorAll('[data-part="notices"]')).toHaveLength(1)
    expect(mounted.root.querySelector('[data-part="notices"] [role="status"]')?.textContent).toBe('Loading…')
    wait.resolve(['Mars'])
    await settle()

    expect(mounted.root.querySelector('[data-part="notices"] [role="status"]')?.textContent).toBe('')
  })
})

describe('Table source races and refreshes', () => {
  test('a slow older answer never lands over a newer one, retry racing included', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined)
    const waits = [deferred<Planet[]>(), deferred<Planet[]>()]
    const loaded: number[] = []
    let call = 0

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: async () => waits[call++]!.promise, rowKey: 'id', onLoad: (rows: Planet[]) => loaded.push(rows.length) })
    await settle()

    waits[0]!.reject(new Error('first failed'))
    await settle()

    expect(mounted.root.querySelector('[role="alert"]')).not.toBeNull()

    click(mounted.root.querySelector('[role="alert"] button'))
    await settle()
    waits[1]!.resolve(PLANETS)
    await settle()

    expect(names(mounted.root)).toEqual(['Mars', 'Earth'])
    expect(mounted.root.querySelector('[role="alert"]')).toBeNull()
    expect(loaded).toEqual([2])
    quiet.mockRestore()
  })

  test('an older promise resolving after the app passed a newer one is dropped', async () => {
    const slow = deferred<Planet[]>()
    const fast = deferred<Planet[]>()

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: slow.promise, rowKey: 'id' })
    await mounted.setProps({ rows: fast.promise })
    fast.resolve([{ id: 9, name: 'Pluto' }])
    await settle()
    slow.resolve(PLANETS)
    await settle()

    expect(names(mounted.root)).toEqual(['Pluto'])
  })

  test('an array replacing a pending promise draws at once and the promise is dropped', async () => {
    const wait = deferred<Planet[]>()

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: wait.promise, rowKey: 'id' })
    expect(skeletons(mounted.root)).toBe(5)

    await mounted.setProps({ rows: [{ id: 5, name: 'Mercury' }] })
    wait.resolve(PLANETS)
    await settle()

    expect(skeletons(mounted.root)).toBe(0)
    expect(names(mounted.root)).toEqual(['Mercury'])
  })

  test('a refresh keeps the rows shown and dims them, and a failed refresh keeps them beside the failure with its retry', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined)
    const refresh = deferred<Planet[]>()

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: () => PLANETS, rowKey: 'id' })
    await settle()
    await mounted.setProps({ rows: async () => refresh.promise })

    const table = mounted.root.querySelector('table')!

    expect(table.getAttribute('aria-busy')).toBe('true')
    expect(table.className).toContain('aria-busy:opacity-60')
    expect(names(mounted.root)).toEqual(['Mars', 'Earth'])
    expect(skeletons(mounted.root)).toBe(0)

    refresh.reject(new Error('down'))
    await settle()

    expect(names(mounted.root)).toEqual(['Mars', 'Earth'])
    expect(mounted.root.querySelector('[role="alert"] button')).not.toBeNull()
    expect(mounted.root.querySelector('[data-part="emptyCell"]')).toBeNull()
    quiet.mockRestore()
  })

  test('the export button is disabled while the rows are on their way', async () => {
    mounted = await mountComponent(Table, { columns: COLUMNS, rows: [], rowKey: 'id', exportable: true, busy: true })

    expect(mounted.root.querySelector('[data-part="selection"] button')?.hasAttribute('disabled')).toBe(true)
  })

  test('a linked row only raises its own controls: no row link, no raising', async () => {
    mounted = await mountComponent(Table, { columns: COLUMNS, rows: PLANETS, rowKey: 'id' })
    const plain = mounted.root.querySelector('[data-part="row"]')?.className ?? ''

    mounted.unmount()
    mounted = await mountComponent(Table, { columns: COLUMNS, rows: PLANETS, rowKey: 'id', rowHref: () => '/x' })

    expect(plain).toContain('data-linked:isolate')
    expect(mounted.root.querySelector('[data-part="row"]')?.hasAttribute('data-linked')).toBe(true)
    expect(mounted.root.querySelector('[data-part="cell"]')?.className).not.toContain('z-1')
  })
})

describe('the empty text of a Table', () => {
  const empty = (root: HTMLElement) => root.querySelector('[data-part="emptyCell"]')?.textContent

  test('is absent while rows are on their way and after a failure, and drawn once they landed empty', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined)
    const wait = deferred<Planet[]>()

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: wait.promise, rowKey: 'id' })

    expect(empty(mounted.root)).toBeUndefined()

    wait.resolve([])
    await settle()

    expect(empty(mounted.root)).toBe('No rows.')

    mounted.unmount()

    const down = deferred<Planet[]>()

    mounted = await mountComponent(Table, { columns: COLUMNS, rows: down.promise, rowKey: 'id' })
    down.reject(new Error('down'))
    await settle()

    expect(empty(mounted.root)).toBeUndefined()
    quiet.mockRestore()
  })

  test('is drawn for a paged list whose first page is empty, absent while it restarts, and an empty emptyLabel draws nothing', async () => {
    const wait = deferred<Planet[]>()
    const feed = infiniteList<Planet>([], { pageSize: 2, load: async () => wait.promise })

    mounted = await mountComponent(Table, { columns: COLUMNS, list: feed, rowKey: 'id' })

    expect(empty(mounted.root)).toBe('No rows.')

    void feed.restart({ filter: { text: 'x' } })
    await settle()

    expect(feed.pending()).toBe(true)
    expect(empty(mounted.root)).toBeUndefined()

    mounted.unmount()
    mounted = await mountComponent(Table, { columns: COLUMNS, rows: [], rowKey: 'id', emptyLabel: '' })

    expect(mounted.root.querySelector('[data-part="emptyCell"]')).toBeNull()
  })
})
