/** @jsxImportSource kay */
// Accessible Cmd+K / Ctrl+K CommandPalette built on native `<dialog>` + fine-grained signals.

import type { Signal } from 'kay'
import { computed, effect, onMount, signal } from 'kay'

export interface CommandItem {
  id: string
  label: string
  group?: string | undefined
  shortcut?: string | undefined
  href?: string | undefined
  onSelect?: (() => void) | undefined
}

export interface CommandPaletteProps {
  items: CommandItem[]
  placeholder?: string | undefined
  triggerLabel?: string | undefined
  shortcutKey?: string | undefined
  open?: Signal<boolean> | undefined
  onSelect?: ((id: string) => void) | undefined
}

export function CommandPalette({
  items,
  placeholder = 'Type a command or search...',
  triggerLabel = 'Search (⌘K)',
  shortcutKey = 'k',
  open,
  onSelect,
}: CommandPaletteProps) {
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
    const wantOpen = isOpen.value
    const el = dialogEl
    if (el === undefined)
      return
    if (wantOpen) {
      if (!el.open)
        el.showModal()
      query.value = ''
      activeIdx.value = 0
      queueMicrotask(() => inputEl?.focus())
    }
    else if (el.open) {
      el.close()
    }
  })

  const runItem = (item: CommandItem) => {
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
          onClick={() => { isOpen.value = true }}
        >
          {triggerLabel}
        </button>
      )}
      <dialog
        data-ui="command"
        data-part="content"
        ref={(el) => { dialogEl = el as HTMLDialogElement }}
        onClose={() => { isOpen.value = false }}
        onClick={(e) => {
          if (e.target === dialogEl)
            isOpen.value = false
        }}
      >
        <div data-part="input-wrap">
          <input
            ref={(el) => { inputEl = el as HTMLInputElement }}
            data-part="input"
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            placeholder={placeholder}
            value={query.value}
            onInput={(e) => {
              query.value = (e.target as HTMLInputElement).value
              activeIdx.value = 0
            }}
            onKeyDown={(e) => {
              const list = filtered.value
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                activeIdx.value = list.length > 0 ? (activeIdx.value + 1) % list.length : 0
              }
              else if (e.key === 'ArrowUp') {
                e.preventDefault()
                activeIdx.value = list.length > 0 ? (activeIdx.value - 1 + list.length) % list.length : 0
              }
              else if (e.key === 'Enter' && list[activeIdx.value]) {
                e.preventDefault()
                runItem(list[activeIdx.value]!)
              }
            }}
          />
        </div>
        <div data-part="list" role="listbox">
          {filtered.value.map((item, idx) => (
            <button
              key={item.id}
              type="button"
              role="option"
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
          <p data-part="empty">No matching commands.</p>
        )}
      </dialog>
    </div>
  )
}
