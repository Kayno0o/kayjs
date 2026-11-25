/** @jsxImportSource @kayjs/kay */
// Interactive DataTable island powered by headless `createDataTable()` signals (sort, filter, select, paginate).

import { createDataTable } from './behaviors'

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

export function DataTable({
  rows,
  columns,
  rowKey = 'id',
  pageSize = 10,
  searchable = true,
  selectable = false,
  placeholder = 'Filter rows...',
  searchLabel = 'Search',
  selectColumnLabel = 'Select',
  selectRowLabel = 'Select row',
  rowsLabel = 'rows',
  selectedLabel = 'selected',
  pageLabel = 'Page',
  prevLabel = 'Prev',
  nextLabel = 'Next',
}: DataTableProps) {
  const table = createDataTable({
    rows: () => rows,
    getKey: r => String(r[rowKey] ?? ''),
    pageSize,
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
              table.query.value = (e.target as HTMLInputElement).value
              table.page.value = 1
            }}
          />
          <span data-part="meta">
            {table.filtered.value.length}
            {' '}
            {rowsLabel}
            {selectable && table.selected.value.size > 0 ? ` · ${table.selected.value.size} ${selectedLabel}` : ''}
          </span>
        </div>
      )}

      <div data-part="scroll">
        <table data-ui="table">
          <thead>
            <tr>
              {selectable && <th data-part="select-col" aria-label={selectColumnLabel} />}
              {columns.map(col => (
                <th
                  key={col.key}
                  aria-sort={
                    table.sortBy.value === col.key
                      ? (table.sortDir.value === 'asc' ? 'ascending' : 'descending')
                      : 'none'
                  }
                >
                  {col.sortable !== false
                    ? (
                        <button
                          type="button"
                          data-part="sort"
                          data-active={table.sortBy.value === col.key ? 'true' : undefined}
                          onClick={() => table.toggleSort(col.key)}
                        >
                          {col.label}
                          {table.sortBy.value === col.key ? (table.sortDir.value === 'asc' ? ' ↑' : ' ↓') : ''}
                        </button>
                      )
                    : col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.visible.value.map(row => (
              <tr key={String(row[rowKey] ?? '')} data-selected={table.isSelected(String(row[rowKey] ?? '')) ? 'true' : undefined}>
                {selectable && (
                  <td data-part="select-col">
                    <input
                      type="checkbox"
                      checked={table.isSelected(String(row[rowKey] ?? ''))}
                      aria-label={`${selectRowLabel} ${String(row[rowKey] ?? '')}`}
                      onChange={() => table.toggleSelect(String(row[rowKey] ?? ''))}
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
            {pageLabel} {table.page.value} / {table.totalPages.value}
          </span>
          <div data-layout="cluster">
            <button
              data-ui="button"
              data-variant="outline"
              data-size="sm"
              type="button"
              disabled={table.page.value <= 1}
              onClick={() => { table.page.value = Math.max(1, table.page.value - 1) }}
            >
              {prevLabel}
            </button>
            <button
              data-ui="button"
              data-variant="outline"
              data-size="sm"
              type="button"
              disabled={table.page.value >= table.totalPages.value}
              onClick={() => { table.page.value = Math.min(table.totalPages.value, table.page.value + 1) }}
            >
              {nextLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
