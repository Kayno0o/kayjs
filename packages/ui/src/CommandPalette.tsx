/** @jsxImportSource @kayjs/kay */
// Accessible Cmd+K / Ctrl+K CommandPalette built on native `<dialog>` + fine-grained signals.

import type { Signal } from '@kayjs/kay'
import { computed, effect, onMount, signal } from '@kayjs/kay'
import { handleListKeyDown, isDialogBackdropClick, nextUiId, syncDialogOpen } from './behaviors'

export interface CommandItem {
  id: string
  label: string
  group?: string | undefined
  shortcut?: string | undefined
  href?: string | undefined
  disabled?: boolean | undefined
  onSelect?: (() => void) | undefined
}

export interface CommandPaletteProps {
  id?: string | undefined
  items: CommandItem[]
  placeholder?: string | undefined
  inputLabel?: string | undefined
  ariaLabel?: string | undefined
  triggerLabel?: string | undefined
  emptyLabel?: string | undefined
  noResultsLabel?: string | undefined
  resultLabel?: string | undefined
  resultsLabel?: string | undefined
  shortcutKey?: string | undefined
  open?: Signal<boolean> | undefined
  onSelect?: ((id: string) => void) | undefined
}

export function CommandPalette({
  id,
  items,
  placeholder = 'Type a command or search...',
  inputLabel = 'Search commands',
  ariaLabel = 'Command palette',
  triggerLabel = 'Search (⌘K)',
  emptyLabel = 'No matching commands.',
  noResultsLabel = 'No results',
  resultLabel = 'result',
  resultsLabel = 'results',
  shortcutKey = 'k',
  open,
  onSelect,
}: CommandPaletteProps) {
  const baseId = id ?? nextUiId('kui-cmd')
  const listId = `${baseId}-list`
  const optionId = (idx: number) => `${baseId}-opt-${idx}`

  const isOpen = open ?? signal(false)
  const query = signal('')
  const activeIdx = signal(0)
  let dialogEl: HTMLDialogElement | undefined
  let inputEl: HTMLInputElement | undefined

  const filtered = computed(() => {
    const q = query.value.trim().toLowerCase()
    if (!q)
      return items
    return items.filter(it =>
      it.label.toLowerCase().includes(q) || (it.group?.toLowerCase().includes(q) ?? false),
    )
  })

  const activeOptionId = () => {
    const list = filtered.value
    const idx = activeIdx.value
    if (!isOpen.value || idx < 0 || idx >= list.length || list[idx]?.disabled)
      return undefined
    return optionId(idx)
  }

  const statusText = () => {
    if (!isOpen.value)
      return ''
    const n = filtered.value.length
    if (n === 0)
      return noResultsLabel
    return n === 1 ? `1 ${resultLabel}` : `${n} ${resultsLabel}`
  }

  const onOpened = () => {
    query.value = ''
    activeIdx.value = 0
    queueMicrotask(() => inputEl?.focus())
  }

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === shortcutKey.toLowerCase()) {
        e.preventDefault()
        isOpen.value = !isOpen.value
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  effect(() => {
    syncDialogOpen(dialogEl, isOpen, isOpen.value, onOpened)
  })

  const runItem = (item: CommandItem) => {
    if (item.disabled)
      return
    isOpen.value = false
    item.onSelect?.()
    onSelect?.(item.id)
    if (item.href)
      window.location.assign(item.href)
  }

  return (
    <div data-ui="command-root" data-state={isOpen.value ? 'open' : 'closed'}>
      {triggerLabel && (
        <button
          data-ui="button"
          data-variant="outline"
          data-part="trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={isOpen.value ? 'true' : 'false'}
          onClick={() => { isOpen.value = true }}
        >
          {triggerLabel}
        </button>
      )}
      <dialog
        data-ui="command"
        data-part="content"
        aria-label={ariaLabel}
        ref={(el) => {
          dialogEl = el as HTMLDialogElement
          syncDialogOpen(dialogEl, isOpen, isOpen.peek(), onOpened)
        }}
        onClose={() => { isOpen.value = false }}
        onClick={(e) => {
          if (isDialogBackdropClick(e, dialogEl))
            isOpen.value = false
        }}
      >
        <div data-part="panel">
          <div data-part="input-wrap">
            <input
              ref={(el) => { inputEl = el as HTMLInputElement }}
              data-part="input"
              type="search"
              role="combobox"
              aria-label={inputLabel}
              aria-expanded={isOpen.value ? 'true' : 'false'}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={activeOptionId()}
              placeholder={placeholder}
              value={query.value}
              onInput={(e) => {
                query.value = (e.target as HTMLInputElement).value
                activeIdx.value = 0
              }}
              onKeyDown={(e) => {
                handleListKeyDown(e, {
                  items: () => filtered.value,
                  activeIndex: activeIdx,
                  isDisabled: it => Boolean(it.disabled),
                  onSelect: item => runItem(item),
                  onClose: () => { isOpen.value = false },
                  selectOnSpace: false,
                })
              }}
            />
          </div>
          <div id={listId} data-part="list" role="listbox" aria-label={inputLabel}>
            {filtered.value.map((item, idx) => (
              <button
                key={item.id}
                id={optionId(idx)}
                type="button"
                role="option"
                tabindex={-1}
                disabled={item.disabled}
                aria-disabled={item.disabled ? 'true' : undefined}
                data-part="item"
                data-highlighted={activeIdx.value === idx ? 'true' : undefined}
                aria-selected={activeIdx.value === idx ? 'true' : 'false'}
                onMouseEnter={() => { activeIdx.value = idx }}
                onClick={() => runItem(item)}
              >
                <span data-part="item-label">{item.label}</span>
                {item.shortcut && <kbd data-part="kbd">{item.shortcut}</kbd>}
              </button>
            ))}
          </div>
          {filtered.value.length === 0 && (
            <p data-part="empty">{emptyLabel}</p>
          )}
          <div class="kui-sr-only" role="status" aria-live="polite" aria-atomic="true">
            {statusText()}
          </div>
        </div>
      </dialog>
    </div>
  )
}
