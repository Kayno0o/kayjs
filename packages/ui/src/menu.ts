import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'

export interface MenuAction {
  label: string
  icon?: IconSlot | IconProps
  // `danger` paints the entry as destructive.
  tone?: 'neutral' | 'danger' | undefined
  // Deprecated: use `tone: 'danger'`, which wins when both are given.
  danger?: boolean
  disabled?: boolean
  // Runs once the menu has closed, so a dialog it opens takes focus from the page rather than from a vanished menu.
  onSelect: () => void
}

// An action, or a rule between groups of them.
export type MenuEntry = MenuAction | 'separator'
