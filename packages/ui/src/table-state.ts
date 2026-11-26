// Headless DataTable behavior (O(1) selection, clamped pagination, leak-free row signal eviction).

import type { ReadonlySignal, Signal } from '@kayjs/kay'
import { computed, signal } from '@kayjs/kay'

export interface DataTableOptions<T> {
  rows: () => readonly T[]
  getKey: (row: T) => string | number
  searchText?: (row: T) => string
  pageSize?: number | undefined
}

export interface DataTableState<T> {
  readonly query: Signal<string>
  readonly sortBy: Signal<keyof T | undefined>
  readonly sortDir: Signal<'asc' | 'desc'>
  readonly page: Signal<number>
  readonly selected: Signal<Set<string | number>>
  readonly filtered: ReadonlySignal<T[]>
  readonly visible: ReadonlySignal<T[]>
  readonly totalPages: ReadonlySignal<number>
  toggleSort(col: keyof T): void
  toggleSelect(key: string | number): void
  isSelected(key: string | number): boolean
  clearSelection(): void
}

export function createDataTable<T>(options: DataTableOptions<T>): DataTableState<T> {
  const query = signal('')
  const sortBy = signal<keyof T | undefined>(undefined)
  const sortDir = signal<'asc' | 'desc'>('asc')
  const rawPage = signal(1)
  const selected = signal<Set<string | number>>(new Set())
  const rowSelected = new Map<string | number, Signal<boolean>>()
  const pageSize = options.pageSize ?? 25

  const filtered = computed<T[]>(() => {
    const q = query.value.trim().toLowerCase()
    const base = options.rows()
    if (rowSelected.size > 0) {
      const live = new Set(base.map(options.getKey))
      for (const k of rowSelected.keys()) {
        if (!live.has(k))
          rowSelected.delete(k)
      }
    }
    let list = q === ''
      ? [...base]
      : base.filter(row => (options.searchText ? options.searchText(row) : JSON.stringify(row)).toLowerCase().includes(q))

    const col = sortBy.value
    if (col !== undefined) {
      const mul = sortDir.value === 'asc' ? 1 : -1
      list = list.sort((a, b) => {
        const av = a[col]
        const bv = b[col]
        return av === bv ? 0 : av == null ? 1 : bv == null ? -1 : av < bv ? -mul : mul
      })
    }
    return list
  })

  const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
  const clampedPage = computed(() => Math.min(Math.max(1, rawPage.value), totalPages.value))
  const page: Signal<number> = {
    get value() { return clampedPage.value },
    set value(v: number) { rawPage.value = Math.min(Math.max(1, Math.trunc(v)), totalPages.peek()) },
    peek: () => clampedPage.peek(),
  }

  const visible = computed<T[]>(() => {
    const start = (clampedPage.value - 1) * pageSize
    return filtered.value.slice(start, start + pageSize)
  })

  return {
    query,
    sortBy,
    sortDir,
    page,
    selected,
    filtered,
    visible,
    totalPages,
    toggleSort(col) {
      if (sortBy.value === col) {
        sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
      }
      else {
        sortBy.value = col
        sortDir.value = 'asc'
      }
    },
    toggleSelect(key) {
      const next = new Set(selected.peek())
      const willSelect = !next.has(key)
      if (willSelect)
        next.add(key)
      else
        next.delete(key)
      selected.value = next
      const perRow = rowSelected.get(key)
      if (perRow !== undefined)
        perRow.value = willSelect
    },
    isSelected(key) {
      let perRow = rowSelected.get(key)
      if (perRow === undefined) {
        perRow = signal(selected.peek().has(key))
        rowSelected.set(key, perRow)
      }
      return perRow.value
    },
    clearSelection() {
      const prev = selected.peek()
      if (prev.size === 0)
        return
      selected.value = new Set()
      for (const k of prev) {
        const perRow = rowSelected.get(k)
        if (perRow !== undefined)
          perRow.value = false
      }
    },
  }
}
