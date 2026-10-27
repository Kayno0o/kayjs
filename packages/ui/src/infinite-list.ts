import type { Action, CallOptions, InputOf } from 'kay'
import type { SortState } from './table'
import type { AttemptOptions } from './toast'
import { signal, untrack } from 'kay'
import { attempt } from './toast'

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

interface InfiniteListBase<Row> {
  // The rows a full page holds: a page of fewer ends the list.
  pageSize: number
  // Tells a row from another, so one already shown is dropped when the list shifts between two pages, and `patch` finds the row to change.
  key?: ((row: Row) => unknown) | undefined
  // The sort the first page is already in, which the first `load` receives.
  sort?: SortState | undefined
}

// A source of any kind: the function `load` runs for each page.
export interface LoadSource<Row> {
  load: (at: PageAt<Row>) => Promise<InfinitePage<Row>> | InfinitePage<Row>
  action?: undefined
}

// What an action answers, once it went through.
type Answered<Target extends Action<never, unknown>> = Awaited<ReturnType<Target>>

// The part of an action source that reads the rows out of its answer: left out when the answer is the rows.
type RowsOf<Row, Target extends Action<never, unknown>> = [Answered<Target>] extends [Row[]]
  ? { rows?: ((answer: Answered<Target>) => Row[]) | undefined }
  : { rows: (answer: Answered<Target>) => Row[] }

// An action as the source: each page calls it with `{ refresh: false }` through `attempt`, so a failure toasts `failure` and fails the page.
export type ActionSource<Row, Target extends Action<never, unknown>> = {
  action: Target
  // The fields of the call besides the paging: with an object, `offset` and `limit` (the page size) are added, so an action declaring both reads them from `pageFields`. A function gets where the page starts and answers the whole input, for a cursor or a sort; `undefined` loads nothing and resolves an empty page, such as a cursor with no row to continue after.
  input?: Partial<InputOf<Target>> | ((at: PageAt<Row>) => Partial<InputOf<Target>> | undefined) | undefined
  // What `attempt` toasts when the call fails.
  failure: string | AttemptOptions
  load?: undefined
} & RowsOf<Row, Target>

export type InfiniteListOptions<Row, Target extends Action<never, unknown> = never> = InfiniteListBase<Row> & (LoadSource<Row> | ActionSource<Row, Target>)

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
  // The sort the rows are in, or being loaded in.
  sort: () => SortState | undefined
  // Starts the list over in that order: the rows go, and the first page comes from `load` at offset 0 with the sort. A page on its way for the old order is dropped when it lands.
  sortBy: (sort: SortState | undefined) => Promise<void>
  // Loads again the page that failed; nothing when no page failed.
  retry: () => Promise<void>
  // Changes the loaded row `key` reads as `id`, from the fields to merge over it or a function returning the row; `undefined` changes nothing, so the answer of an `attempt` that failed passes as is. Answers whether a loaded row matched, which needs the `key` option.
  patch: (id: unknown, change: RowChange<Row> | undefined) => boolean
}

// What `patch` applies to a row: the fields to merge over it, or a function of the row returning the row.
export type RowChange<Row> = Partial<Row> | ((row: Row) => Row)

// The page loader of an action source.
function loadFromAction<Row, Target extends Action<never, unknown>>(source: ActionSource<Row, Target>, size: number): (at: PageAt<Row>) => Promise<InfinitePage<Row>> {
  const call = source.action as unknown as (input: object, options: CallOptions) => Promise<unknown>
  const { input } = source
  const rowsOf = source.rows as ((answer: unknown) => Row[]) | undefined

  return async (at) => {
    const given = typeof input === 'function' ? input(at) : { ...input, offset: at.offset, limit: size }

    if (given === undefined)
      return []

    const answer = await attempt(async () => call(given, { refresh: false }), source.failure)

    if (answer === undefined)
      return undefined

    return rowsOf === undefined ? answer as Row[] : rowsOf(answer)
  }
}

// The rows of a list that loads its next page as it scrolls, with `LoadMore` after the list drawing the sentinel and the failed state. The first page comes from the server; a page shorter than `pageSize` ends the list, one call runs at a time and a failed page loads no other until `retry`.
export function infiniteList<Row, Target extends Action<never, unknown> = never>(first: Row[], options: InfiniteListOptions<Row, Target>): InfiniteList<Row> {
  const { key, pageSize: size } = options
  const load = options.load === undefined ? loadFromAction(options, size) : options.load
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

  function patch(id: unknown, change: RowChange<Row> | undefined): boolean {
    if (key === undefined || change === undefined)
      return false

    const index = untrack(rows).findIndex(row => Object.is(key(row), id))

    if (index === -1)
      return false

    const changed = (row: Row): Row => typeof change === 'function' ? change(row) : { ...row, ...change }

    rows.set(current => current.map((row, at) => at === index ? changed(row) : row))

    return true
  }

  const more = async () => failed() ? undefined : loadPage()
  const retry = async () => failed() ? loadPage() : undefined

  return { rows, ended, failed, pending, more, retry, sort: () => sort, sortBy, patch }
}
