import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'

export interface MenuAction {
  label: string
  icon?: IconSlot | IconProps
  // Paints the entry as destructive.
  danger?: boolean
  disabled?: boolean
  // Runs once the menu has closed, so a dialog it opens takes focus from the page rather than from a vanished menu.
  onSelect: () => void
}

// An action, or a rule between groups of them.
export type MenuEntry = MenuAction | 'separator'
