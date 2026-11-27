// Headless signal behavior hooks (zero CSS, zero DOM lock-in — standard TSX `{...spread}`).
// DataTable and Tabs state live in ./table-state.ts and ./tabs-state.ts so lightweight pages don't download them.

import type { Signal } from '@kayjs/kay'
import { effect, onCleanup, signal, useId } from '@kayjs/kay'
import { useFieldContext } from './field-context'

export { createDataTable } from './table-state'
export type { DataTableOptions, DataTableState } from './table-state'
export { createTabs } from './tabs-state'
export type { TabsBehavior } from './tabs-state'
export { toast } from './toast'
export type { ToastItem } from './toast'
export { useFieldContext }

// ---- Stable hydration-safe unique IDs for ARIA wiring ----

export function nextUiId(prefix: string): string {
  return useId(prefix)
}

// ---- Shared listbox / menu keyboard navigation ----

export function findFirstEnabledIndex<T>(items: readonly T[], isDisabled?: (item: T) => boolean): number {
  return findNextEnabledIndex(items, -1, 1, isDisabled)
}

export function findLastEnabledIndex<T>(items: readonly T[], isDisabled?: (item: T) => boolean): number {
  return findNextEnabledIndex(items, items.length, -1, isDisabled)
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
  homeEnd?: boolean | undefined
  closeOnTab?: boolean | undefined
}

/** Shared keyboard handler for ARIA menu / listbox / combobox popups (ArrowUp/Down, Home/End, Enter/Space, Escape, Tab). */
export function handleListKeyDown<T>(e: KeyboardEvent, opts: ListNavigationOptions<T>): boolean {
  const list = opts.items()
  if (e.key === 'Escape') {
    opts.onClose(true)
    return true
  }
  if (e.key === 'Tab') {
    if (opts.closeOnTab === false)
      return false
    opts.onClose(false)
    return true
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    opts.activeIndex.value = findNextEnabledIndex(list, opts.activeIndex.value, e.key === 'ArrowDown' ? 1 : -1, opts.isDisabled)
    return true
  }
  if (opts.homeEnd !== false && (e.key === 'Home' || e.key === 'End')) {
    e.preventDefault()
    opts.activeIndex.value = (e.key === 'Home' ? findFirstEnabledIndex : findLastEnabledIndex)(list, opts.isDisabled)
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

export interface ListPopupOptions<T> {
  items: () => readonly T[]
  itemId: (idx: number) => string
  isDisabled: (item: T) => boolean
  onSelect: (item: T, idx: number) => void
  initialIndex?: () => number
  focusActive?: boolean | undefined
}

export interface ListPopupState {
  readonly open: Signal<boolean>
  readonly highlighted: Signal<number>
  setRoot(el: HTMLElement | undefined): void
  close(returnFocus?: boolean): void
  toggle(e: MouseEvent): void
  onTriggerKeyDown(e: KeyboardEvent): void
  focusActive(): void
  activeDescendantId(): string | undefined
  /** The popup's `ref`: shows it in the top layer, anchored to the trigger. */
  mountPopup(el: HTMLElement | undefined): void
}

// In the top layer no overflow ancestor clips the popup, and the trigger as its `source` is the anchor CSS places it against and a click the browser does not count as outside.
function showAnchored(el: HTMLElement, trigger: HTMLElement): void {
  if (el.isConnected && !el.matches(':popover-open'))
    el.showPopover({ source: trigger })
}

/** Shared popup open/close and keyboard list navigation for Menu and Select; the browser dismisses the popup on an outside click. */
export function createListPopup<T>(opts: ListPopupOptions<T>): ListPopupState {
  const open = signal(false)
  const highlighted = signal(findFirstEnabledIndex(opts.items(), opts.isDisabled))
  let rootEl: HTMLElement | undefined
  let lastOpenEvent: Event | undefined

  const activeDescendantId = (): string | undefined => {
    const idx = highlighted.value
    const list = opts.items()
    return !open.value || idx < 0 || idx >= list.length || opts.isDisabled(list[idx]!) ? undefined : opts.itemId(idx)
  }

  const focusActive = () => {
    const id = opts.focusActive ? activeDescendantId() : undefined
    if (!id)
      return
    const el = document.getElementById(id)
    if (el)
      el.focus()
    else
      queueMicrotask(() => document.getElementById(id)?.focus())
  }

  const openWith = (last: boolean) => {
    open.value = true
    const init = opts.initialIndex?.()
    highlighted.value = init !== undefined && init >= 0
      ? init
      : (last ? findLastEnabledIndex : findFirstEnabledIndex)(opts.items(), opts.isDisabled)
    focusActive()
  }

  const close = (returnFocus = false) => {
    open.value = false
    if (returnFocus)
      rootEl?.querySelector<HTMLElement>('[data-part="trigger"]')?.focus()
  }

  effect(() => {
    if (!open.value)
      return
    const onKey = (e: KeyboardEvent) => {
      if (e === lastOpenEvent)
        return
      const prev = highlighted.peek()
      handleListKeyDown(e, {
        items: opts.items,
        activeIndex: highlighted,
        isDisabled: opts.isDisabled,
        onSelect: opts.onSelect,
        onClose: close,
        selectOnSpace: true,
      })
      if (open.peek() && highlighted.peek() !== prev)
        focusActive()
    }
    document.addEventListener('keydown', onKey)
    onCleanup(() => document.removeEventListener('keydown', onKey))
  })

  return {
    open,
    highlighted,
    setRoot(el) { rootEl = el },
    close,
    toggle(e) {
      e.stopPropagation()
      if (open.value)
        close()
      else
        openWith(false)
    },
    onTriggerKeyDown(e) {
      if (!open.value && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        e.stopPropagation()
        lastOpenEvent = e
        openWith(e.key === 'ArrowUp')
      }
    },
    focusActive,
    activeDescendantId,
    mountPopup(el) {
      if (el === undefined)
        return
      el.addEventListener('toggle', e => (e as ToggleEvent).newState === 'closed' && close())
      queueMicrotask(() => {
        showAnchored(el, rootEl!.querySelector<HTMLElement>('[data-part="trigger"]')!)
        focusActive()
      })
    },
  }
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
  if (rect.width === 0 && rect.height === 0)
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
