/** @jsxImportSource @kayjs/kay */
// Accessible dropdown Menu primitive with roving menuitem focus, link items, ArrowDown/Up trigger open, Escape/Tab close & click-outside dismiss.

import type { ButtonVariant } from './static'
import { createListPopup, nextUiId } from './behaviors'

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

export function Menu(props: MenuProps) {
  const baseId = props.id ?? nextUiId('kui-menu')
  const triggerId = `${baseId}-trigger`
  const menuId = `${baseId}-menu`
  const itemId = (idx: number) => `${baseId}-item-${idx}`
  const variant = props.variant ?? 'outline'
  const label = props.label

  const activate = (item: MenuItemDef, navigateHref: boolean) => {
    if (item.disabled)
      return
    item.onSelect?.()
    props.onSelect?.(item.id)
    popup.close(item.href === undefined)
    if (navigateHref && item.href !== undefined && typeof location !== 'undefined')
      location.assign(item.href)
  }

  const popup = createListPopup<MenuItemDef>({
    items: () => props.items,
    itemId,
    isDisabled: it => Boolean(it.disabled),
    onSelect: active => activate(active, true),
    focusActive: true,
  })

  return (
    <div
      data-ui="menu"
      data-state={popup.open.value ? 'open' : 'closed'}
      ref={(el) => { popup.setRoot(el) }}
    >
      <button
        id={triggerId}
        data-ui="button"
        data-variant={variant}
        data-part="trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={popup.open.value ? 'true' : 'false'}
        aria-controls={popup.open.value ? menuId : undefined}
        onClick={e => popup.toggle(e)}
        onKeyDown={e => popup.onTriggerKeyDown(e)}
      >
        {label}
      </button>
      {popup.open.value && (
        <div
          id={menuId}
          data-part="content"
          role="menu"
          aria-labelledby={triggerId}
          ref={() => { popup.focusActive() }}
        >
          {props.items.map((item, idx) => (
            item.href !== undefined && !item.disabled
              ? (
                  <a
                    key={item.id}
                    id={itemId(idx)}
                    data-part="item"
                    data-highlighted={popup.highlighted.value === idx ? 'true' : undefined}
                    role="menuitem"
                    href={item.href}
                    tabindex={-1}
                    onClick={() => activate(item, false)}
                  >
                    {item.label}
                  </a>
                )
              : (
                  <button
                    key={item.id}
                    id={itemId(idx)}
                    data-part="item"
                    data-highlighted={popup.highlighted.value === idx ? 'true' : undefined}
                    role="menuitem"
                    type="button"
                    tabindex={-1}
                    disabled={item.disabled}
                    aria-disabled={item.disabled ? 'true' : undefined}
                    onClick={() => activate(item, false)}
                  >
                    {item.label}
                  </button>
                )
          ))}
        </div>
      )}
    </div>
  )
}
