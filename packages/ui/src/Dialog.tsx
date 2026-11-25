/** @jsxImportSource @kayjs/kay */
// Accessible native `<dialog>` primitive (shared by Dialog and Drawer: top-layer, Esc-to-close, ::backdrop, focus return).

import type { KayChild, Signal } from '@kayjs/kay'
import type { ButtonVariant } from './static'
import { effect, signal } from '@kayjs/kay'
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

export interface ModalDialogSurfaceProps extends DialogProps {
  kind: 'dialog' | 'drawer'
  side?: 'right' | 'left' | 'bottom' | undefined
}

export function ModalDialogSurface({
  kind,
  side,
  id,
  title,
  ariaLabel,
  description,
  triggerLabel,
  triggerVariant = 'outline',
  closeLabel = 'Close',
  open,
  children,
}: ModalDialogSurfaceProps) {
  const baseId = id ?? nextUiId(`kui-${kind}`)
  const titleId = `${baseId}-title`
  const descId = `${baseId}-desc`

  const isOpen = open ?? signal(false)
  let dialogEl: HTMLDialogElement | undefined

  effect(() => {
    syncDialogOpen(dialogEl, isOpen, isOpen.value)
  })

  const fallbackLabel = kind === 'drawer' ? 'Drawer' : 'Dialog'

  return (
    <div data-ui={`${kind}-root`} data-state={isOpen.value ? 'open' : 'closed'}>
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
        data-ui={kind}
        data-side={side}
        data-part="content"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? (ariaLabel ?? fallbackLabel) : undefined}
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

export interface DrawerProps extends DialogProps {
  side?: 'right' | 'left' | 'bottom' | undefined
}

export function Dialog(props: DialogProps) {
  return ModalDialogSurface({ ...props, kind: 'dialog' })
}

export function Drawer({ side = 'right', ...rest }: DrawerProps) {
  return ModalDialogSurface({ ...rest, kind: 'drawer', side })
}
