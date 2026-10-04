export type SortDirection = 'asc' | 'desc'

export interface SortState {
  key: string
  direction: SortDirection
}

export interface Column<Row> {
  key: string
  header: string
  align?: 'start' | 'center' | 'end'
  // What the column sorts by: a function of the row, or `true` for the row's own value at `key`. A column without one is not sortable.
  sortValue?: ((row: Row) => string | number) | true
  // The direction the first click on its header sorts by.
  defaultDirection?: SortDirection
  // Drawn by the table's `@cell(row, column)` block rather than as the row's value at `key`.
  cell?: true
}

// How a table tells its rows apart: a field of the row, or a function of it.
export type RowKey<Row> = (keyof Row & string) | ((row: Row) => string | number)

export function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number')
    return a - b

  return String(a).localeCompare(String(b))
}

export function rowKeyOf<Row>(row: Row, key: RowKey<Row>): unknown {
  return typeof key === 'function' ? key(row) : row[key]
}

function valueAt<Row>(row: Row, key: string): unknown {
  return (row as Record<string, unknown>)[key]
}

// What a column without a `@cell` block shows: its row's own value at `key`, as text.
export function cellText<Row>(row: Row, column: Column<Row>): string {
  const value = valueAt(row, column.key)

  return value === undefined || value === null ? '' : String(value)
}

// The row's own value as `sortValue: true` sorts it: a date by its time, a boolean as 0 or 1, and nothing for a missing value, which sorts last either way.
function sortable(value: unknown): string | number | undefined {
  if (value === undefined || value === null)
    return undefined

  if (value instanceof Date)
    return value.getTime()

  if (typeof value === 'boolean')
    return Number(value)

  return typeof value === 'number' ? value : String(value)
}

export function sortedRows<Row>(rows: Row[], columns: Column<Row>[], sort: SortState | undefined): Row[] {
  const column = sort && columns.find(item => item.key === sort.key)

  if (!sort || !column?.sortValue)
    return rows

  const { sortValue } = column
  const value = sortValue === true ? (row: Row) => sortable(valueAt(row, column.key)) : sortValue
  const factor = sort.direction === 'asc' ? 1 : -1

  return [...rows].sort((a, b) => {
    const first = value(a)
    const second = value(b)

    if (first === undefined || second === undefined)
      return Number(first === undefined) - Number(second === undefined)

    return factor * compareValues(first, second)
  })
}

// The sort a click on `column`'s header leads to: its other direction when it already sorts the table, its default one otherwise.
export function nextSort<Row>(sort: SortState | undefined, column: Column<Row>): SortState {
  return sort?.key === column.key
    ? { key: column.key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
    : { key: column.key, direction: column.defaultDirection ?? 'desc' }
}
