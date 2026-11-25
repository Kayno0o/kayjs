/** @jsxImportSource @kayjs/kay */
// Accessible dropdown Menu primitive with aria-activedescendant navigation, Escape/Tab close & click-outside dismiss.

import type { ButtonVariant } from './static'
import { effect, onCleanup, signal } from '@kayjs/kay'
import { findFirstEnabledIndex, handleListKeyDown, nextUiId } from './behaviors'

export interface MenuItemDef {
  id: string
  label: string
  href?: string | undefined
  disabled?: boolean | undefined
  onSelect?: (() => void) | undefined
}

export interface MenuProps {
  id?: string | undefined
  label: string
  items: MenuItemDef[]
  variant?: ButtonVariant | undefined
  onSelect?: ((id: string) => void) | undefined
}

export function Menu({ id, label, items, variant = 'outline', onSelect }: MenuProps) {
  const baseId = id ?? nextUiId('kui-menu')
  const triggerId = `${baseId}-trigger`
  const menuId = `${baseId}-menu`
  const itemId = (idx: number) => `${baseId}-item-${idx}`

  const open = signal(false)
  const highlighted = signal(findFirstEnabledIndex(items, it => Boolean(it.disabled)))
  let rootEl: HTMLElement | undefined

  const close = (returnFocus = false) => {
    open.value = false
    if (returnFocus)
      rootEl?.querySelector<HTMLElement>('[data-part="trigger"]')?.focus()
  }

  const activeItemId = () => {
    const idx = highlighted.value
    if (!open.value || idx < 0 || idx >= items.length || items[idx]?.disabled)
      return undefined
    return itemId(idx)
  }

  effect(() => {
    if (!open.value)
      return
    const onDocClick = (e: MouseEvent) => {
      if (rootEl && !rootEl.contains(e.target as Node))
        close()
    }
    const onKey = (e: KeyboardEvent) => {
      handleListKeyDown(e, {
        items: () => items,
        activeIndex: highlighted,
        isDisabled: it => Boolean(it.disabled),
        onSelect: (active) => {
          active.onSelect?.()
          onSelect?.(active.id)
          close()
        },
        onClose: returnFocus => close(returnFocus),
        selectOnSpace: true,
      })
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
      ref={(el) => { rootEl = el as HTMLElement }}
    >
      <button
        id={triggerId}
        data-ui="button"
        data-variant={variant}
        data-part="trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open.value ? 'true' : 'false'}
        aria-controls={menuId}
        aria-activedescendant={activeItemId()}
        onClick={(e) => {
          e.stopPropagation()
          open.value = !open.value
          if (open.value)
            highlighted.value = findFirstEnabledIndex(items, it => Boolean(it.disabled))
        }}
      >
        {label}
      </button>
      {open.value && (
        <div
          id={menuId}
          data-part="content"
          role="menu"
          aria-labelledby={triggerId}
        >
          {items.map((item, idx) => (
            <button
              key={item.id}
              id={itemId(idx)}
              data-part="item"
              data-highlighted={highlighted.value === idx ? 'true' : undefined}
              role="menuitem"
              type="button"
              tabindex={-1}
              disabled={item.disabled}
              aria-disabled={item.disabled ? 'true' : undefined}
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
