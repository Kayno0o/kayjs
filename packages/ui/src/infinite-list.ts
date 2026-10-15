import { signal } from 'kay'

// What a source resolves to: the rows of the next page, or `undefined` for a page that failed, such as the result of an `attempt` that toasted. A throw fails the page too.
export type InfinitePage<Row> = Row[] | undefined

// Where the next page starts, for a source paging by offset or by cursor.
export interface PageAt<Row> {
  // How many rows were fetched so far, duplicates included, which is what an offset source skips.
  offset: number
  // The last row fetched, duplicates included, which a cursor source continues after; undefined for a list that began empty.
  last: Row | undefined
}

export interface InfiniteListOptions<Row> {
  // The rows a full page holds: a page of fewer ends the list.
  size: number
  // Tells a row from another, so one already shown is dropped when the list shifts between two pages.
  key?: ((row: Row) => unknown) | undefined
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
  // Loads again the page that failed; nothing when no page failed.
  retry: () => Promise<void>
}

// The rows of a list that loads its next page as it scrolls, with `LoadMore` after the list drawing the sentinel and the failed state. The first page comes from the server; a page shorter than `size` ends the list, one call runs at a time and a failed page loads no other until `retry`.
export function infiniteList<Row>(first: Row[], options: InfiniteListOptions<Row>): InfiniteList<Row> {
  const { size, key, load } = options
  const rows = signal(first)
  const ended = signal(first.length < size)
  const failed = signal(false)
  const pending = signal(false)
  const shown = new Set(key === undefined ? [] : first.map(key))
  let fetched = first.length
  let lastFetched = first.at(-1)
  let running = false

  async function loadPage(): Promise<void> {
    if (running || ended())
      return

    running = true
    pending.set(true)

    try {
      const page = await load({ offset: fetched, last: lastFetched })

      if (page === undefined) {
        failed.set(true)

        return
      }

      fetched += page.length
      lastFetched = page.at(-1) ?? lastFetched
      ended.set(page.length < size)
      failed.set(false)

      const fresh = key === undefined ? page : page.filter(row => !shown.has(key(row)) && shown.add(key(row)))

      if (fresh.length > 0)
        rows.set(current => [...current, ...fresh])
    }
    catch {
      failed.set(true)
    }
    finally {
      running = false
      pending.set(false)
    }
  }

  const more = async () => failed() ? undefined : loadPage()
  const retry = async () => failed() ? loadPage() : undefined

  return { rows, ended, failed, pending, more, retry }
}
