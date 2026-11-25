// Headless signal behavior hooks (zero CSS, zero DOM lock-in — standard TSX `{...spread}`).
// Every interactive primitive in @kayjs/ui is built on these hooks, and apps can use them directly!

import type { ReadonlySignal, Signal } from 'kay'
import type { Tone } from './static'
import { computed, selector, signal, useId } from 'kay'

// ---- Stable hydration-safe unique IDs for ARIA wiring ----

export function nextUiId(prefix: string): string {
  return useId(prefix)
}

// ---- Shared listbox / menu keyboard navigation ----

export function findFirstEnabledIndex<T>(items: readonly T[], isDisabled?: (item: T) => boolean): number {
  for (let i = 0; i < items.length; i++) {
    if (!isDisabled?.(items[i]!))
      return i
  }
  return -1
}

export function findLastEnabledIndex<T>(items: readonly T[], isDisabled?: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (!isDisabled?.(items[i]!))
      return i
  }
  return -1
}

export function findNextEnabledIndex<T>(
  items: readonly T[],
  current: number,
  delta: 1 | -1,
  isDisabled?: (item: T) => boolean,
): number {
  const len = items.length
  if (len === 0)
    return -1
  let idx = current < 0 || current >= len ? (delta === 1 ? -1 : len) : current
  for (let step = 0; step < len; step++) {
    idx = (idx + delta + len) % len
    if (!isDisabled?.(items[idx]!))
      return idx
  }
  return -1
}

export interface ListNavigationOptions<T> {
  items: () => readonly T[]
  activeIndex: Signal<number>
  isDisabled?: ((item: T) => boolean) | undefined
  onSelect: (item: T, index: number) => void
  onClose: (returnFocus?: boolean) => void
  selectOnSpace?: boolean | undefined
}

/** Shared keyboard handler for ARIA menu / listbox / combobox popups (ArrowUp/Down, Home/End, Enter/Space, Escape, Tab). */
export function handleListKeyDown<T>(e: KeyboardEvent, opts: ListNavigationOptions<T>): boolean {
  const list = opts.items()
  if (e.key === 'Escape') {
    opts.onClose(true)
    return true
  }
  if (e.key === 'Tab') {
    // Close without preventing default so focus naturally moves on without trapping.
    opts.onClose(false)
    return true
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    opts.activeIndex.value = findNextEnabledIndex(list, opts.activeIndex.value, 1, opts.isDisabled)
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    opts.activeIndex.value = findNextEnabledIndex(list, opts.activeIndex.value, -1, opts.isDisabled)
    return true
  }
  if (e.key === 'Home') {
    e.preventDefault()
    opts.activeIndex.value = findFirstEnabledIndex(list, opts.isDisabled)
    return true
  }
  if (e.key === 'End') {
    e.preventDefault()
    opts.activeIndex.value = findLastEnabledIndex(list, opts.isDisabled)
    return true
  }
  if (e.key === 'Enter' || (opts.selectOnSpace !== false && e.key === ' ')) {
    const idx = opts.activeIndex.value
    const active = idx >= 0 && idx < list.length ? list[idx] : undefined
    if (active !== undefined && !opts.isDisabled?.(active)) {
      e.preventDefault()
      opts.onSelect(active, idx)
      return true
    }
  }
  return false
}

// ---- Shared native <dialog> sync & backdrop click helpers ----

/** Syncs a native `<dialog>` element's modal state, handling initial `open={signal(true)}` on mount/hydration. */
export function syncDialogOpen(
  el: HTMLDialogElement | undefined,
  isOpen: Signal<boolean>,
  wantOpen: boolean,
  onOpened?: () => void,
): void {
  if (el === undefined)
    return
  if (wantOpen) {
    if (!el.open) {
      try {
        el.showModal()
        onOpened?.()
      }
      catch {
        // In real browsers, showModal() throws InvalidStateError until the element is connected to the document.
        // Deferring to a microtask runs right after mount() appends the node into its container.
        queueMicrotask(() => {
          if (isOpen.peek() && !el.open && el.isConnected) {
            el.showModal()
            onOpened?.()
          }
        })
      }
    }
  }
  else if (el.open) {
    el.close()
  }
}

/** Returns true only when a click on `<dialog>` targeted the backdrop outside its inner panel. */
export function isDialogBackdropClick(e: MouseEvent, dialogEl: HTMLDialogElement | undefined): boolean {
  if (dialogEl === undefined || e.target !== dialogEl)
    return false
  const rect = dialogEl.getBoundingClientRect()
  const hasLayout = rect.width > 0 || rect.height > 0
  if (!hasLayout)
    return true
  return e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom
}

// ---- Dialog behavior ----

export interface DialogBehavior {
  readonly open: Signal<boolean>
  show(): void
  close(): void
  toggle(): void
  readonly triggerProps: Record<string, unknown>
}

export function createDialog(initial = false): DialogBehavior {
  const open = signal(initial)
  return {
    open,
    show: () => { open.value = true },
    close: () => { open.value = false },
    toggle: () => { open.value = !open.value },
    get triggerProps() {
      return {
        'type': 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': open.value ? 'true' : 'false',
        'onClick': () => { open.value = true },
      }
    },
  }
}

// ---- Tabs behavior (roving arrow-key + Home/End navigation) ----

export interface TabsBehavior {
  readonly active: Signal<string>
  select(id: string): void
  isActive(id: string): boolean
  onKeyDown(e: KeyboardEvent, ids: readonly string[]): void
}

export function createTabs(initial: string): TabsBehavior {
  const active = signal(initial)
  const sel = selector(() => active.value)

  return {
    active,
    select(id: string) {
      active.value = id
    },
    isActive: (id: string) => sel.is(id),
    onKeyDown(e: KeyboardEvent, ids: readonly string[]) {
      const idx = ids.indexOf(active.value)
      if (idx === -1 || ids.length === 0)
        return
      let next = -1
      if (e.key === 'ArrowRight') next = (idx + 1) % ids.length
      else if (e.key === 'ArrowLeft') next = (idx - 1 + ids.length) % ids.length
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = ids.length - 1
      if (next !== -1) {
        e.preventDefault()
        active.value = ids[next]!
        const tablist = (e.currentTarget as HTMLElement | null)?.closest('[role="tablist"]')
        const buttons = tablist?.querySelectorAll<HTMLElement>('[role="tab"]')
        buttons?.[next]?.focus()
      }
    },
  }
}

// ---- Toast reactive store ----

export interface ToastItem {
  id: string
  title: string
  description?: string | undefined
  tone: Tone
}

const TOAST_KEY = Symbol.for('kay.ui.toasts')
const toastSignal: Signal<ToastItem[]> = ((globalThis as Record<symbol, Signal<ToastItem[]> | undefined>)[TOAST_KEY] ??= signal<ToastItem[]>([]))

let toastSeq = 0

function pushToast(tone: Tone, title: string, description?: string, durationMs = 4500): string {
  const id = `t-${++toastSeq}`
  toastSignal.value = [...toastSignal.value, { id, title, description, tone }]
  if (durationMs > 0 && typeof setTimeout !== 'undefined')
    setTimeout(() => toast.dismiss(id), durationMs)
  return id
}

export const toast = {
  items: toastSignal,
  show: (title: string, description?: string, durationMs?: number) => pushToast('neutral', title, description, durationMs),
  info: (title: string, description?: string, durationMs?: number) => pushToast('accent', title, description, durationMs),
  success: (title: string, description?: string, durationMs?: number) => pushToast('success', title, description, durationMs),
  warning: (title: string, description?: string, durationMs?: number) => pushToast('warning', title, description, durationMs),
  danger: (title: string, description?: string, durationMs?: number) => pushToast('danger', title, description, durationMs),
  error: (title: string, description?: string, durationMs?: number) => pushToast('danger', title, description, durationMs),
  dismiss(id: string) {
    toastSignal.value = toastSignal.value.filter(t => t.id !== id)
  },
  clear() {
    toastSignal.value = []
  },
}

// ---- Headless DataTable behavior (O(1) selection via selector(), zero opinionated DOM!) ----

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
  const page = signal(1)
  const selected = signal<Set<string | number>>(new Set())
  const pageSize = options.pageSize ?? 25

  const filtered = computed<T[]>(() => {
    const q = query.value.trim().toLowerCase()
    const base = options.rows()
    let list = q === ''
      ? [...base]
      : base.filter((row) => {
          const hay = options.searchText ? options.searchText(row) : JSON.stringify(row)
          return hay.toLowerCase().includes(q)
        })

    const col = sortBy.value
    if (col !== undefined) {
      const mul = sortDir.value === 'asc' ? 1 : -1
      list = list.sort((a, b) => {
        const av = a[col]
        const bv = b[col]
        if (av === bv)
          return 0
        if (av == null)
          return 1
        if (bv == null)
          return -1
        return av < bv ? -mul : mul
      })
    }
    return list
  })

  const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))

  const visible = computed<T[]>(() => {
    const p = Math.min(page.value, totalPages.value)
    const start = (p - 1) * pageSize
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
      const next = new Set(selected.value)
      if (next.has(key))
        next.delete(key)
      else
        next.add(key)
      selected.value = next
    },
    isSelected(key) {
      return selected.value.has(key)
    },
    clearSelection() {
      selected.value = new Set()
    },
  }
}
