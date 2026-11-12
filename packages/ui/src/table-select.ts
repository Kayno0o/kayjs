import type { RowKey, RowKeyValue } from './table'
import { effect, memo, signal } from 'kay'
import { rowKeyOf } from './table'

export interface SelectionInput<Row, Key extends RowKey<Row>> {
  rowKey: Key
  // The rows the table holds, and those its filter keeps.
  rows: () => Row[]
  kept: () => Row[]
  selected: () => RowKeyValue<Row, Key>[] | undefined
  onChange: () => ((keys: RowKeyValue<Row, Key>[], rows: Row[]) => unknown) | undefined
  enabled: () => boolean
  // Whether the rows are still on their way or failed to come: the selection is held then.
  settling: () => boolean
}

// What a Table with `selectable` holds: the keys picked, which follow `selected` and leave with a row that leaves `rows`.
export function selection<Row, Key extends RowKey<Row>>(input: SelectionInput<Row, Key>) {
  type Value = RowKeyValue<Row, Key>

  const none: Value[] = []
  const picked = signal<Value[]>(input.selected() ?? none)

  effect(() => {
    picked.set(input.selected() ?? none)
  })

  const keyed = memo(() => input.rows().map(row => rowKeyOf(row, input.rowKey)))
  const chosen = memo(() => {
    const set = new Set(picked())

    return keyed().filter(key => set.has(key))
  }, { equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]) })
  const chosenSet = memo(() => new Set(chosen()))
  const visible = memo(() => input.kept().map(row => rowKeyOf(row, input.rowKey)))
  const allChosen = memo(() => visible().length > 0 && visible().every(key => chosenSet().has(key)))
  const someChosen = memo(() => visible().some(key => chosenSet().has(key)))

  function commit(keys: Value[]) {
    picked.set(keys)

    const notify = input.onChange()

    if (!notify)
      return

    const wanted = new Set(keys)

    notify(keys, input.rows().filter(row => wanted.has(rowKeyOf(row, input.rowKey))))
  }

  function pick(key: Value, on: boolean) {
    commit(on ? keyed().filter(other => other === key || chosenSet().has(other)) : chosen().filter(other => other !== key))
  }

  // Only the rows the filter shows are picked or dropped, so a row it hides keeps its state.
  function pickAll(on: boolean) {
    const shownKeys = new Set(visible())

    commit(on ? keyed().filter(key => chosenSet().has(key) || shownKeys.has(key)) : chosen().filter(key => !shownKeys.has(key)))
  }

  // A row that left `rows` leaves the selection for good, so it is not picked again if it comes back. With no rows yet, loading or failed, `selected` is held: its rows are on their way, not gone.
  effect(() => {
    const next = chosen()

    if (input.enabled() && next.length !== picked().length && (input.rows().length > 0 || !input.settling()))
      commit(next)
  })

  return { chosen, chosenSet, visible, allChosen, someChosen, commit, pick, pickAll }
}
