import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'

// An app of the family an AppSwitcher links to.
export interface SwitcherApp {
  // Matched against the switcher's `current` to mark the app on screen.
  id: string
  href: string
  label: string
  // Drawn above the name; an app with none shows the first letter of its name.
  icon?: IconSlot | IconProps | undefined
  // Shown as the tile's tooltip.
  description?: string | undefined
  // Opens this app in a new tab, or keeps it in the same one when `false`, whatever the switcher does.
  newTab?: boolean | undefined
  // The tile's `rel` when it opens in a new tab, `noopener` by default.
  rel?: string | undefined
}
