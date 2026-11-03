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
  // Whether a footer offers a way to close it.
  footer: boolean
}

// What the `closedby` attribute of an overlay says, from its guard: a click outside or Escape, Escape alone, or neither. Typing inside counts on its own, though Escape still closes a modal with no footer.
export function closeWatcher({ modal, docked = false, dirty, edited, footer }: CloseWatcherState): 'any' | 'closerequest' | 'none' {
  if (docked || dirty)
    return 'none'

  if (!modal)
    return 'closerequest'

  if (!edited)
    return 'any'

  return footer ? 'none' : 'closerequest'
}
