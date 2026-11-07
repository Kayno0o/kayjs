import type { NavLink } from './defaults'

// A titled run of links in a SideNav; without a `label` the links stand with no heading.
export interface SideNavGroup {
  label?: string | undefined
  links: readonly NavLink[]
}
