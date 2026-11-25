/** @jsxImportSource kay */
// Accessible native `<dialog>` primitive (top-layer, Esc-to-close, ::backdrop, focus return for free!).

import type { KayChild, Signal } from 'kay'
import type { ButtonVariant } from './static'
import { effect, signal } from 'kay'
import { isDialogBackdropClick, nextUiId, syncDialogOpen } from './behaviors'

export interface DialogProps {
  id?: string | undefined
  title?: string | undefined
  ariaLabel?: string | undefined
  description?: string | undefined
  triggerLabel?: string | undefined
  triggerVariant?: ButtonVariant | undefined
  closeLabel?: string | undefined
  open?: Signal<boolean> | undefined
  children?: KayChild | undefined
}

export function Dialog({ id, title, ariaLabel, description, triggerLabel, triggerVariant = 'outline', closeLabel = 'Close', open, children }: DialogProps) {
  const baseId = id ?? nextUiId('kui-dialog')
  const titleId = `${baseId}-title`
  const descId = `${baseId}-desc`

  const isOpen = open ?? signal(false)
  let dialogEl: HTMLDialogElement | undefined

  effect(() => {
    syncDialogOpen(dialogEl, isOpen, isOpen.value)
  })

  return (
    <div data-ui="dialog-root" data-state={isOpen.value ? 'open' : 'closed'}>
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
        data-ui="dialog"
        data-part="content"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? (ariaLabel ?? 'Dialog') : undefined}
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
              aria-label={closeLabel}
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
