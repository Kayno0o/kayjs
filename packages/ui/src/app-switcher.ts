import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'
import type { NewTab } from './outside'

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
  // Opens this app in a new tab, keeps it in the same one when `false`, or opens it in a new tab when it leaves the site with `'auto'`, whatever the switcher does.
  newTab?: NewTab | undefined
  // The tile's `rel` when it opens in a new tab, `noopener noreferrer` by default.
  rel?: string | undefined
}
