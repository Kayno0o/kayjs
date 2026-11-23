// Accessible dropdown Menu primitive with roving arrow-key navigation, Escape close & click-outside dismiss.

import type { ButtonVariant } from './static'
import { effect, onCleanup, signal } from 'kay'

export interface MenuItemDef {
  id: string
  label: string
  href?: string | undefined
  disabled?: boolean | undefined
  onSelect?: (() => void) | undefined
}

export interface MenuProps {
  label: string
  items: MenuItemDef[]
  variant?: ButtonVariant | undefined
  onSelect?: ((id: string) => void) | undefined
}

export function Menu({ label, items, variant = 'outline', onSelect }: MenuProps) {
  const open = signal(false)
  const highlighted = signal(0)
  let rootEl: HTMLElement | undefined

  const close = () => { open.value = false }

  effect(() => {
    if (!open.value)
      return
    const onDocClick = (e: MouseEvent) => {
      if (rootEl && !rootEl.contains(e.target as Node))
        close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        rootEl?.querySelector<HTMLElement>('[data-part="trigger"]')?.focus()
      }
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        highlighted.value = (highlighted.value + 1) % items.length
      }
      else if (e.key === 'ArrowUp') {
        e.preventDefault()
        highlighted.value = (highlighted.value - 1 + items.length) % items.length
      }
      else if (e.key === 'Enter' || e.key === ' ') {
        const active = items[highlighted.value]
        if (active && !active.disabled) {
          e.preventDefault()
          active.onSelect?.()
          onSelect?.(active.id)
          close()
        }
      }
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    onCleanup(() => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    })
  })

  return (
    <div
      data-ui="menu"
      data-state={open.value ? 'open' : 'closed'}
      style="position:relative;display:inline-block"
      ref={(el) => { rootEl = el as HTMLElement }}
    >
      <button
        data-ui="button"
        data-variant={variant}
        data-part="trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open.value ? 'true' : 'false'}
        onClick={(e) => {
          e.stopPropagation()
          open.value = !open.value
          if (open.value)
            highlighted.value = 0
        }}
      >
        {label}
      </button>
      {open.value && (
        <div
          data-part="content"
          role="menu"
          style="position:absolute;inset-block-start:calc(100% + 4px);inset-inline-start:0;z-index:40"
        >
          {items.map((item, idx) => (
            <button
              key={item.id}
              data-part="item"
              data-highlighted={highlighted.value === idx ? 'true' : undefined}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled)
                  return
                item.onSelect?.()
                onSelect?.(item.id)
                close()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
