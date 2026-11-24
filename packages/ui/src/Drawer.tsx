/** @jsxImportSource kay */
// Accessible native `<dialog>` side/bottom Drawer primitive (top-layer, Esc-to-close, ::backdrop).

import type { KayChild, Signal } from 'kay'
import type { ButtonVariant } from './static'
import { effect, signal } from 'kay'
import { isDialogBackdropClick, nextUiId, syncDialogOpen } from './behaviors'

export interface DrawerProps {
  id?: string | undefined
  title?: string | undefined
  ariaLabel?: string | undefined
  description?: string | undefined
  side?: 'right' | 'left' | 'bottom' | undefined
  triggerLabel?: string | undefined
  triggerVariant?: ButtonVariant | undefined
  open?: Signal<boolean> | undefined
  children?: KayChild | undefined
}

export function Drawer({
  id,
  title,
  ariaLabel,
  description,
  side = 'right',
  triggerLabel,
  triggerVariant = 'outline',
  open,
  children,
}: DrawerProps) {
  const baseId = id ?? nextUiId('kui-drawer')
  const titleId = `${baseId}-title`
  const descId = `${baseId}-desc`

  const isOpen = open ?? signal(false)
  let dialogEl: HTMLDialogElement | undefined

  effect(() => {
    syncDialogOpen(dialogEl, isOpen, isOpen.value)
  })

  return (
    <div data-ui="drawer-root" data-state={isOpen.value ? 'open' : 'closed'}>
      {triggerLabel && (
        <button
          data-ui="button"
          data-variant={triggerVariant}
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
        data-ui="drawer"
        data-side={side}
        data-part="content"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? (ariaLabel ?? 'Drawer') : undefined}
        aria-describedby={description ? descId : undefined}
        ref={(el) => {
          dialogEl = el as HTMLDialogElement
          syncDialogOpen(dialogEl, isOpen, isOpen.peek())
        }}
        onClose={() => { isOpen.value = false }}
        onClick={(e) => {
          if (isDialogBackdropClick(e, dialogEl))
            isOpen.value = false
        }}
      >
        <div data-part="panel">
          <header data-part="header" data-layout="split">
            {title && <h2 id={titleId} data-part="title">{title}</h2>}
            <button
              data-ui="button"
              data-variant="ghost"
              data-size="sm"
              data-part="close"
              type="button"
              aria-label="Close"
              onClick={() => { isOpen.value = false }}
            >
              ✕
            </button>
          </header>
          {description && <p id={descId} data-part="description">{description}</p>}
          <div data-part="body">{children}</div>
        </div>
      </dialog>
    </div>
  )
}
