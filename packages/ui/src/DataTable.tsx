/** @jsxImportSource @kayjs/kay */
// Interactive DataTable island powered by headless `createDataTable()` signals (sort, filter, select, paginate).

import { createDataTable } from './table-state'

export interface DataTableColumn {
  key: string
  label: string
  sortable?: boolean | undefined
}

export interface DataTableProps {
  rows: Array<Record<string, string | number>>
  columns: DataTableColumn[]
  rowKey?: string | undefined
  pageSize?: number | undefined
  searchable?: boolean | undefined
  selectable?: boolean | undefined
  caption?: string | undefined
  ariaLabel?: string | undefined
  placeholder?: string | undefined
  searchLabel?: string | undefined
  selectColumnLabel?: string | undefined
  selectRowLabel?: string | undefined
  rowsLabel?: string | undefined
  selectedLabel?: string | undefined
  pageLabel?: string | undefined
  prevLabel?: string | undefined
  nextLabel?: string | undefined
}

export function DataTable(props: DataTableProps) {
  const rowKey = props.rowKey ?? 'id'
  const searchable = props.searchable ?? true
  const selectable = props.selectable ?? false
  const caption = props.caption
  const ariaLabel = props.ariaLabel
  const placeholder = props.placeholder ?? 'Filter rows...'
  const searchLabel = props.searchLabel ?? 'Search'
  const selectColumnLabel = props.selectColumnLabel ?? 'Select'
  const selectRowLabel = props.selectRowLabel ?? 'Select row'
  const rowsLabel = props.rowsLabel ?? 'rows'
  const selectedLabel = props.selectedLabel ?? 'selected'
  const pageLabel = props.pageLabel ?? 'Page'
  const prevLabel = props.prevLabel ?? 'Prev'
  const nextLabel = props.nextLabel ?? 'Next'
  const columns = props.columns
  const keyOf = (r: Record<string, string | number>) => String(r[rowKey] ?? '')
  const sortOf = (k: string) => (table.sortBy.value === k ? table.sortDir.value : undefined)

  const table = createDataTable({
    rows: () => props.rows,
    getKey: keyOf,
    pageSize: props.pageSize ?? 10,
    searchText: r => columns.map(c => String(r[c.key] ?? '')).join(' '),
  })

  return (
    <div data-ui="datatable">
      {searchable && (
        <div data-part="toolbar" data-layout="split">
          <input
            data-part="search"
            type="search"
            aria-label={searchLabel}
            placeholder={placeholder}
            value={table.query.value}
            onInput={(e) => {
              table.query.value = e.currentTarget.value
              table.page.value = 1
            }}
          />
          <span data-part="meta">
            {`${table.filtered.value.length} ${rowsLabel}${selectable && table.selected.value.size > 0 ? ` · ${table.selected.value.size} ${selectedLabel}` : ''}`}
          </span>
        </div>
      )}

      <div data-part="scroll">
        <table data-ui="table" aria-label={caption ? undefined : ariaLabel}>
          {caption && <caption data-part="caption">{caption}</caption>}
          <thead>
            <tr>
              {selectable && (
                <th scope="col" data-part="select-col">
                  <span class="kui-sr-only">{selectColumnLabel}</span>
                </th>
              )}
              {columns.map(col => (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={col.sortable === false ? undefined : sortOf(col.key) === 'asc' ? 'ascending' : sortOf(col.key) === 'desc' ? 'descending' : 'none'}
                >
                  {col.sortable !== false
                    ? (
                        <button
                          type="button"
                          data-part="sort"
                          data-active={sortOf(col.key) ? 'true' : undefined}
                          onClick={() => table.toggleSort(col.key)}
                        >
                          {col.label}
                          <span aria-hidden="true">{sortOf(col.key) === 'asc' ? ' ↑' : sortOf(col.key) === 'desc' ? ' ↓' : ''}</span>
                        </button>
                      )
                    : col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.visible.value.map(row => (
              <tr key={keyOf(row)} data-selected={table.isSelected(keyOf(row)) ? 'true' : undefined}>
                {selectable && (
                  <td data-part="select-col">
                    <input
                      type="checkbox"
                      checked={table.isSelected(keyOf(row))}
                      aria-label={`${selectRowLabel} ${keyOf(row)}`}
                      onChange={() => table.toggleSelect(keyOf(row))}
                    />
                  </td>
                )}
                {columns.map(col => (
                  <td key={col.key}>{String(row[col.key] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {table.totalPages.value > 1 && (
        <div data-part="pagination" data-layout="split">
          <span data-part="meta">
            {`${pageLabel} ${table.page.value} / ${table.totalPages.value}`}
          </span>
          <div data-layout="cluster">
            <button
              data-ui="button"
              data-variant="outline"
              data-size="sm"
              type="button"
              disabled={table.page.value <= 1}
              onClick={() => { table.page.value-- }}
            >
              {prevLabel}
            </button>
            <button
              data-ui="button"
              data-variant="outline"
              data-size="sm"
              type="button"
              disabled={table.page.value >= table.totalPages.value}
              onClick={() => { table.page.value++ }}
            >
              {nextLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
