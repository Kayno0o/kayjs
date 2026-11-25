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

export interface DrawerProps extends DialogProps {
  side?: 'right' | 'left' | 'bottom' | undefined
}

// Takes `props` without spreading so lazy `get children()` getters evaluate strictly inside `<div data-part="body">`.
function renderModalDialog(props: DrawerProps, kind: 'dialog' | 'drawer', defaultSide?: 'right' | 'left' | 'bottom') {
  const baseId = props.id ?? nextUiId(`kui-${kind}`)
  const titleId = `${baseId}-title`
  const descId = `${baseId}-desc`
  const triggerVariant = props.triggerVariant ?? 'outline'
  const closeLabel = props.closeLabel ?? 'Close'
  const side = kind === 'drawer' ? (props.side ?? defaultSide ?? 'right') : undefined

  const isOpen = props.open ?? signal(false)
  let dialogEl: HTMLDialogElement | undefined

  effect(() => {
    syncDialogOpen(dialogEl, isOpen, isOpen.value)
  })

  const fallbackLabel = kind === 'drawer' ? 'Drawer' : 'Dialog'

  return (
    <div data-ui={`${kind}-root`} data-state={isOpen.value ? 'open' : 'closed'}>
      {props.triggerLabel && (
        <button
          data-ui="button"
          data-variant={triggerVariant}
          data-part="trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={isOpen.value ? 'true' : 'false'}
          onClick={() => { isOpen.value = true }}
        >
          {props.triggerLabel}
        </button>
      )}
      <dialog
        data-ui={kind}
        data-side={side}
        data-part="content"
        aria-labelledby={props.title ? titleId : undefined}
        aria-label={!props.title ? (props.ariaLabel ?? fallbackLabel) : undefined}
        aria-describedby={props.description ? descId : undefined}
        ref={(el) => {
          dialogEl = el
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
            {props.title && <h2 id={titleId} data-part="title">{props.title}</h2>}
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
          {props.description && <p id={descId} data-part="description">{props.description}</p>}
          <div data-part="body">{props.children}</div>
        </div>
      </dialog>
    </div>
  )
}

export function Dialog(props: DialogProps) {
  return renderModalDialog(props, 'dialog')
}

export function Drawer(props: DrawerProps) {
  return renderModalDialog(props, 'drawer', 'right')
}
