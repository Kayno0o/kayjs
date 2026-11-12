import type { InfiniteList, ListFilter } from './infinite-list'
import type { SortState } from './table'
import { effect, onCleanup, untrack } from 'kay'
import { sameFields } from './table'

const DEBOUNCE_MS = 200

// A list follows the table's sort and filter whatever set them: a header click, the URL's, the parent's `sort`, a typed text or a field. The first run loads at once, a text waits for a pause in typing, and one load serves a sort and a filter changed together.
export function followList<Row>(list: () => InfiniteList<Row> | undefined, sort: () => SortState | undefined, asked: () => ListFilter) {
  let started = false

  effect(() => {
    const held = list()

    if (!held)
      return

    const wanted = sort()
    const filtered = asked()
    const now = !started

    started = true

    const [sortChanged, filterChanged] = untrack(() => {
      const sorted = held.sort()
      const filter = held.filter()

      return [wanted?.key !== sorted?.key || wanted?.direction !== sorted?.direction, filtered.text !== filter.text || !sameFields(filtered.fields, filter.fields)]
    })

    if (!sortChanged && !filterChanged)
      return

    const run = () => void held.restart({ ...sortChanged && { sort: wanted }, ...filterChanged && { filter: filtered } })

    // A sort runs at once, taking a filter still waiting for its pause along.
    if (now || sortChanged) {
      run()

      return
    }

    const timer = setTimeout(run, DEBOUNCE_MS)

    onCleanup(() => clearTimeout(timer))
  })
}
