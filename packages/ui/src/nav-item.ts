import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'

// What a tab of Tabs and TabNav, and with `label` and `icon` alone an item of a Breadcrumb, can carry beside its text: the same names on every component of the kind.
export interface NavItem {
  label: string
  // Sits before the label.
  icon?: IconSlot | IconProps | undefined
  // A count or short status after the label.
  badge?: string | number | undefined
  disabled?: boolean | undefined
}
