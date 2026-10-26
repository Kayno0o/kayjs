import type { SortState } from './table'
import { signal } from 'kay'

// What a source resolves to: the rows of the next page, or `undefined` for a page that failed, such as the result of an `attempt` that toasted. A throw fails the page too.
export type InfinitePage<Row> = Row[] | undefined

// Where the next page starts, for a source paging by offset or by cursor.
export interface PageAt<Row> {
  // How many rows were fetched so far, duplicates included, which is what an offset source skips.
  offset: number
  // The last row fetched, duplicates included, which a cursor source continues after; undefined for a list that began empty.
  last: Row | undefined
  // The sort `sortBy` last asked for, `undefined` until one was; a source orders its pages by it.
  sort: SortState | undefined
}

export interface InfiniteListOptions<Row> {
  // The rows a full page holds: a page of fewer ends the list.
  pageSize: number
  // Tells a row from another, so one already shown is dropped when the list shifts between two pages.
  key?: ((row: Row) => unknown) | undefined
  // The sort the first page is already in, which the first `load` receives.
  sort?: SortState | undefined
  load: (at: PageAt<Row>) => Promise<InfinitePage<Row>> | InfinitePage<Row>
}

export interface InfiniteList<Row> {
  // The rows loaded so far, the first page first.
  rows: () => Row[]
  // Whether the last page was short, so no more exist.
  ended: () => boolean
  // Whether the last page failed, which waits for `retry` rather than loading another.
  failed: () => boolean
  // Whether a page is on its way.
  pending: () => boolean
  // Loads the next page; nothing while a page is on its way, the list is ended or a failure waits for `retry`.
  more: () => Promise<void>
  // Starts the list over in that order: the rows go, and the first page comes from `load` at offset 0 with the sort. A page on its way for the old order is dropped when it lands.
  sortBy: (sort: SortState | undefined) => Promise<void>
  // Loads again the page that failed; nothing when no page failed.
  retry: () => Promise<void>
}

// The rows of a list that loads its next page as it scrolls, with `LoadMore` after the list drawing the sentinel and the failed state. The first page comes from the server; a page shorter than `pageSize` ends the list, one call runs at a time and a failed page loads no other until `retry`.
export function infiniteList<Row>(first: Row[], options: InfiniteListOptions<Row>): InfiniteList<Row> {
  const { key, load, pageSize: size } = options
  let sort = options.sort
  const rows = signal(first)
  const ended = signal(first.length < size)
  const failed = signal(false)
  const pending = signal(false)
  const shown = new Set<unknown>(key === undefined ? [] : first.map(key))
  let fetched = first.length
  let lastFetched = first.at(-1)
  let running = false
  // Bumped by each `sortBy`, so a page asked for before it is told apart when it lands.
  let order = 0
  // Set by `sortBy` until the first page of the new order lands, which takes the place of the rows shown, so the table keeps them meanwhile.
  let replacing = false

  async function loadPage(): Promise<void> {
    if (running || ended())
      return

    running = true
    pending.set(true)

    const mine = order

    try {
      const page = await load({ offset: fetched, last: lastFetched, sort })

      if (mine !== order)
        return

      if (page === undefined) {
        failed.set(true)

        return
      }

      if (replacing)
        shown.clear()

      fetched += page.length
      lastFetched = page.at(-1) ?? lastFetched
      ended.set(page.length < size)
      failed.set(false)

      // A row is fresh when adding its key grows the set of keys shown.
      const fresh = key === undefined ? page : page.filter(row => shown.size < shown.add(key(row)).size)

      if (replacing) {
        replacing = false
        rows.set(fresh)
      }
      else if (fresh.length > 0) {
        rows.set(current => [...current, ...fresh])
      }
    }
    catch {
      if (mine === order)
        failed.set(true)
    }
    finally {
      if (mine === order) {
        running = false
        pending.set(false)
      }
    }
  }

  async function sortBy(next: SortState | undefined): Promise<void> {
    order += 1
    sort = next
    running = false
    replacing = true
    fetched = 0
    lastFetched = undefined
    ended.set(false)
    failed.set(false)

    return loadPage()
  }

  const more = async () => failed() ? undefined : loadPage()
  const retry = async () => failed() ? loadPage() : undefined

  return { rows, ended, failed, pending, more, retry, sortBy }
}
