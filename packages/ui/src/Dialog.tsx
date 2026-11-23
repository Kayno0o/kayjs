// Accessible native `<dialog>` primitive (top-layer, Esc-to-close, ::backdrop, focus return for free!).

import type { KayChild, Signal } from 'kay'
import type { ButtonVariant } from './static'
import { effect, signal } from 'kay'

export interface DialogProps {
  title: string
  description?: string | undefined
  triggerLabel?: string | undefined
  triggerVariant?: ButtonVariant | undefined
  open?: Signal<boolean> | undefined
  children?: KayChild | undefined
}

export function Dialog({ title, description, triggerLabel, triggerVariant = 'outline', open, children }: DialogProps) {
  const isOpen = open ?? signal(false)
  let dialogEl: HTMLDialogElement | undefined

  effect(() => {
    const wantOpen = isOpen.value
    const el = dialogEl
    if (el === undefined)
      return
    if (wantOpen && !el.open)
      el.showModal()
    else if (!wantOpen && el.open)
      el.close()
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
        ref={(el) => { dialogEl = el as HTMLDialogElement }}
        onClose={() => { isOpen.value = false }}
        onClick={(e) => {
          if (e.target === dialogEl)
            isOpen.value = false
        }}
      >
        <header data-part="header" data-layout="split">
          <h2 data-part="title">{title}</h2>
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
        {description && <p data-part="description">{description}</p>}
        <div data-part="body">{children}</div>
      </dialog>
    </div>
  )
}
