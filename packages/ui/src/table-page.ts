import { effect, memo, persisted, untrack } from 'kay'
import { currentPage, pageCount } from './pagination'

export interface PagingInput<Row> {
  pageSize: () => number | undefined
  pageSizes: () => readonly number[] | undefined
  // The page the app holds, when it does.
  page: () => number | undefined
  pageParam: () => string
  limitParam: () => string
  onPageChange: () => ((page: number, size: number) => unknown) | undefined
  shown: () => Row[]
  // Reads what starts the pages over when it changes: the sort, the typed filter and its fields.
  restarts: () => void
}

// What a Table with a `pageSize` holds: the page and the size, kept in the address like the sort, unless the app holds the page itself.
export function paging<Row>(input: PagingInput<Row>) {
  // Whether the table pages is decided when it is made.
  const size = untrack(input.pageSize)
  const keptPage = size === undefined ? undefined : persisted.query(input.pageParam(), '', { history: 'push' })
  const keptSize = size === undefined ? undefined : persisted.query(input.limitParam(), '')
  const pageNow = () => input.page() ?? (Number(keptPage?.()) || 1)

  const sizeNow = () => {
    const asked = Number(keptSize?.())

    return asked > 0 && input.pageSizes()?.includes(asked) ? asked : input.pageSize() ?? 0
  }

  let restarted = false

  // A sort or a filter shows the rows from their first page again, which `onPageChange` hears like a click. The first run is the page loading, which keeps the page the address names.
  effect(() => {
    input.restarts()

    if (!restarted) {
      restarted = true

      return
    }

    untrack(() => {
      if (pageNow() === 1)
        return

      if (input.page() === undefined)
        keptPage?.set('')

      input.onPageChange()?.(1, sizeNow())
    })
  })

  // The page as one that exists, as rows leave or the size grows.
  const pageShown = memo(() => currentPage(pageNow(), pageCount(input.shown().length, sizeNow())))
  const paged = () => input.pageSize() !== undefined && sizeNow() > 0
  const pageRows = () => paged() ? input.shown().slice((pageShown() - 1) * sizeNow(), pageShown() * sizeNow()) : input.shown()

  function goTo(next: number) {
    if (input.page() === undefined)
      keptPage?.set(next > 1 ? String(next) : '')

    input.onPageChange()?.(next, sizeNow())
  }

  function resize(next: number) {
    keptSize?.set(next === input.pageSize() ? '' : String(next))

    if (input.page() === undefined)
      keptPage?.set('')

    input.onPageChange()?.(1, next)
  }

  return { pageShown, paged, pageRows, sizeNow, goTo, resize }
}
