import type { RowKey, RowKeyValue } from './table'
import { effect, memo, signal } from 'kay'
import { rowKeyOf } from './table'

export interface ExpandInput<Row, Key extends RowKey<Row>> {
  tableId: string
  rowKey: Key
  expanded: () => RowKeyValue<Row, Key>[] | undefined
  onOpenChange: () => ((key: RowKeyValue<Row, Key>, open: boolean) => unknown) | undefined
}

// What a Table with `expandable` holds: the keys of the rows open, which follow `expanded`.
export function expanding<Row, Key extends RowKey<Row>>(input: ExpandInput<Row, Key>) {
  type Value = RowKeyValue<Row, Key>

  const none: Value[] = []
  const opened = signal<Value[]>(input.expanded() ?? none)

  effect(() => {
    opened.set(input.expanded() ?? none)
  })

  const openSet = memo(() => new Set(opened()))
  const detailId = (row: Row) => `${input.tableId}-detail-${String(rowKeyOf(row, input.rowKey)).replace(/\s/g, '_')}`

  function toggleRow(key: Value) {
    const open = !openSet().has(key)

    opened.set(open ? [...opened(), key] : opened().filter(other => other !== key))
    input.onOpenChange()?.(key, open)
  }

  return { openSet, detailId, toggleRow }
}
