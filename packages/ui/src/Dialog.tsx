/** @jsxImportSource @kayjs/kay */
// Native `<dialog>` primitives shared by Dialog and Drawer: top layer, Esc and backdrop close, ::backdrop and focus return come from the browser.
// `Dialog` and `Drawer` open from their trigger's `command`, with no JS; `ControlledDialog` and `ControlledDrawer` also follow an `open` signal, as an island.

import type { KayChild, Signal } from '@kayjs/kay'
import type { ButtonVariant } from './static'
import { effect } from '@kayjs/kay'
import { nextUiId, syncDialogOpen } from './behaviors'

export interface DialogProps {
  id?: string | undefined
  title?: string | undefined
  ariaLabel?: string | undefined
  description?: string | undefined
  triggerLabel?: string | undefined
  triggerVariant?: ButtonVariant | undefined
  closeLabel?: string | undefined
  /** A Dialog ships no JS: to open or close it from code, use `ControlledDialog` (or `ControlledDrawer`) with this signal. */
  open?: undefined
  children?: KayChild | undefined
}

export interface DrawerProps extends DialogProps {
  side?: 'right' | 'left' | 'bottom' | undefined
}

export interface ControlledDialogProps extends Omit<DialogProps, 'open'> {
  /** Opens and closes the dialog; the browser closing it (Esc, backdrop, close button) sets it to `false`. */
  open: Signal<boolean>
}

export interface ControlledDrawerProps extends ControlledDialogProps {
  side?: 'right' | 'left' | 'bottom' | undefined
}

type Kind = 'dialog' | 'drawer'
type Shared = Omit<DrawerProps, 'open'>

interface DialogIds {
  baseId: string
  titleId: string
  descId: string
}

function dialogIds(props: Shared, kind: Kind): DialogIds {
  const baseId = props.id ?? nextUiId(`kui-${kind}`)
  return { baseId, titleId: `${baseId}-title`, descId: `${baseId}-desc` }
}

function dialogAttrs(props: Shared, kind: Kind, ids: DialogIds) {
  return {
    'id': ids.baseId,
    'closedby': 'any' as const,
    'data-ui': kind,
    'data-side': kind === 'drawer' ? (props.side ?? 'right') : undefined,
    'data-part': 'content',
    'aria-labelledby': props.title ? ids.titleId : undefined,
    'aria-label': !props.title ? (props.ariaLabel ?? (kind === 'drawer' ? 'Drawer' : 'Dialog')) : undefined,
    'aria-describedby': props.description ? ids.descId : undefined,
  }
}

// Takes `props` without spreading so lazy `get children()` getters evaluate strictly inside `<div data-part="body">`.
function DialogPanel(props: { dialog: Shared, ids: DialogIds }) {
  const { dialog, ids } = props
  return (
    <div data-part="panel">
      <header data-part="header" data-layout="split">
        {dialog.title && <h2 id={ids.titleId} data-part="title">{dialog.title}</h2>}
        <button
          data-ui="button"
          data-variant="ghost"
          data-size="sm"
          data-part="close"
          type="button"
          commandfor={ids.baseId}
          command="close"
          aria-label={dialog.closeLabel ?? 'Close'}
        >
          ✕
        </button>
      </header>
      {dialog.description && <p id={ids.descId} data-part="description">{dialog.description}</p>}
      <div data-part="body">{dialog.children}</div>
    </div>
  )
}

function renderStaticDialog(props: DrawerProps, kind: Kind) {
  const ids = dialogIds(props, kind)
  return (
    <div data-ui={`${kind}-root`}>
      {props.triggerLabel && (
        <button
          data-ui="button"
          data-variant={props.triggerVariant ?? 'outline'}
          data-part="trigger"
          type="button"
          aria-haspopup="dialog"
          commandfor={ids.baseId}
          command="show-modal"
        >
          {props.triggerLabel}
        </button>
      )}
      <dialog {...dialogAttrs(props, kind, ids)}>
        <DialogPanel dialog={props} ids={ids} />
      </dialog>
    </div>
  )
}

function renderControlledDialog(props: ControlledDrawerProps, kind: Kind) {
  const ids = dialogIds(props, kind)
  const isOpen = props.open
  let dialogEl: HTMLDialogElement | undefined

  effect(() => {
    syncDialogOpen(dialogEl, isOpen, isOpen.value)
  })

  return (
    <div data-ui={`${kind}-root`} data-state={isOpen.value ? 'open' : 'closed'}>
      {props.triggerLabel && (
        <button
          data-ui="button"
          data-variant={props.triggerVariant ?? 'outline'}
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
        {...dialogAttrs(props, kind, ids)}
        ref={(el) => {
          dialogEl = el
          syncDialogOpen(dialogEl, isOpen, isOpen.peek())
        }}
        onClose={() => { isOpen.value = false }}
      >
        <DialogPanel dialog={props} ids={ids} />
      </dialog>
    </div>
  )
}

export function Dialog(props: DialogProps) {
  return renderStaticDialog(props, 'dialog')
}

export function Drawer(props: DrawerProps) {
  return renderStaticDialog(props, 'drawer')
}

export function ControlledDialog(props: ControlledDialogProps) {
  return renderControlledDialog(props, 'dialog')
}

export function ControlledDrawer(props: ControlledDrawerProps) {
  return renderControlledDialog(props, 'drawer')
}
