import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'
import type { PopoverTriggerProps } from './popover'
import type { Tone } from './tone'

export interface MenuAction {
  label: string
  icon?: IconSlot | IconProps
  // Colours the entry, such as `danger` for a destructive one.
  tone?: Tone | undefined
  /** @deprecated Use `tone: 'danger'`, which wins when both are given. Removed in 2.0.0. */
  danger?: boolean
  disabled?: boolean
  // Draws the entry as a link, so it takes a middle-click, Ctrl+click and "copy link"; the menu closes once it is followed. An absolute address (`https://...`) opens in a new tab with `rel="noopener noreferrer"`. A disabled entry stays a disabled button.
  href?: string | undefined
  // Runs once the menu has closed, so a dialog it opens takes focus from the page rather than from a vanished menu. Optional on an entry with an `href`, which runs it as the link is followed.
  onSelect?: (() => unknown) | undefined
}

const OTHER_SITE = /^(?:https?:)?\/\//

// Whether a link leaves the site: an absolute or protocol-relative address, read the same on the server and in the browser so hydration agrees.
export function opensOutside(href: string): boolean {
  return OTHER_SITE.test(href)
}

// An action, or a rule between groups of them.
export type MenuEntry = MenuAction | 'separator'

// What a `@trigger` snippet of a Menu is handed: the popover's trigger attributes with the role of what they open, to spread on any element.
export type MenuTriggerProps = PopoverTriggerProps & { 'aria-haspopup': 'menu' | 'true' }

// Adds `aria-haspopup` to the attributes while keeping `aria-expanded` a getter, so a spread of the result still follows the panel.
export function withPopup(attributes: PopoverTriggerProps, popup: MenuTriggerProps['aria-haspopup']): MenuTriggerProps {
  return Object.defineProperty(Object.defineProperties({}, Object.getOwnPropertyDescriptors(attributes)), 'aria-haspopup', { value: popup, enumerable: true }) as MenuTriggerProps
}
