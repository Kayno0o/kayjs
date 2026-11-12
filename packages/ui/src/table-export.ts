import type { Column } from './table'
import { toCsv } from './table'

// Saves the rows as a CSV file the browser downloads.
export function downloadCsv<Row>(rows: Row[], columns: Column<Row>[], name: string): void {
  const url = URL.createObjectURL(new Blob([toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')

  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
