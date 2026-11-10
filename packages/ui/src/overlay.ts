import { navigate } from 'kay'

// The width every overlay (Dialog, SidePanel, CommandPalette, FormDialog) takes by name: `sm`, `md` (the default), `lg`, or `full`, which fills the window less the margin.
export type OverlaySize = 'sm' | 'md' | 'lg' | 'full'

export interface CloseWatcherState {
  // A modal shows over the page and takes a click outside; one that is not leaves the page interactive.
  modal: boolean
  // A panel docked beside the page closes with its own control alone.
  docked?: boolean | undefined
  // Work the overlay must not drop, such as a request in flight.
  dirty: boolean
  // Typed text inside.
  edited: boolean
  // Fields that save as they are typed leave nothing to lose, so typing does not count.
  autosave?: boolean | undefined
  // Whether a footer offers a way to close it.
  footer: boolean
}

// What the `closedby` attribute of an overlay says, from its guard: a click outside or Escape, Escape alone, or neither. Typing inside counts on its own unless the overlay `autosave`s, though Escape still closes a modal with no footer.
export function closeWatcher({ modal, docked = false, dirty, edited, autosave = false, footer }: CloseWatcherState): 'any' | 'closerequest' | 'none' {
  if (docked || dirty)
    return 'none'

  if (!modal)
    return 'closerequest'

  if (!edited || autosave)
    return 'any'

  return footer ? 'none' : 'closerequest'
}

// A close link and no handler: the overlay closes by going to the link, on a click and on Escape.
export function followsHref(closeHref: string | undefined, onOpenChange: unknown): closeHref is string {
  return closeHref !== undefined && onOpenChange === undefined
}

// What the server renders open, so a page driven by the URL shows the overlay before any script runs: one with a `closeHref`, or one beside the page. The client then opens a modal one again as a modal.
export function renderedOpen(open: boolean, modal: boolean, closeHref: string | undefined): boolean {
  return open && (closeHref !== undefined || !modal)
}

// However the overlay closed: it goes to its `closeHref` when that is all it has, else tells the app.
export function leave(closeHref: string | undefined, onOpenChange: ((open: boolean) => unknown) | undefined): void {
  if (followsHref(closeHref, onOpenChange))
    void navigate(closeHref)
  else
    onOpenChange?.(false)
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// The head's close button comes first, so the browser would focus it: focus goes to the first control of the body unless something inside asked for it with `autofocus`, and to the dialog itself when the body holds none.
function focusFirst(dialog: HTMLDialogElement): void {
  if (dialog.querySelector('[autofocus]'))
    return

  const first = dialog.querySelector<HTMLElement>(`[data-part="body"] :is(${FOCUSABLE})`)

  if (first) {
    first.focus()

    return
  }

  dialog.tabIndex = -1
  dialog.focus()
}

// Opens or closes the dialog to match `shown`: a modal one with `showModal()`, one beside the page with `show()`. A dialog the server rendered open is opened again as a modal, its `open` attribute dropped without a close event.
export function syncOpen(dialog: HTMLDialogElement, shown: boolean, modal: boolean, focus = true): void {
  if (shown && modal && dialog.open && !dialog.matches(':modal')) {
    dialog.removeAttribute('open')
    dialog.showModal()

    if (focus)
      focusFirst(dialog)
  }
  else if (shown && !dialog.open) {
    if (modal)
      dialog.showModal()
    else
      dialog.show()

    if (focus)
      focusFirst(dialog)
  }
  else if (!shown && dialog.open) {
    dialog.close()
  }
}
