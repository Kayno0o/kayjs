import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'

export interface MenuAction {
  label: string
  icon?: IconSlot | IconProps
  // `danger` paints the entry as destructive.
  tone?: 'neutral' | 'danger' | undefined
  /** @deprecated Use `tone: 'danger'`, which wins when both are given. Removed in 2.0.0. */
  danger?: boolean
  disabled?: boolean
  // Draws the entry as a link, so it takes a middle-click, Ctrl+click and "copy link"; the menu closes once it is followed. An address of another origin opens in a new tab with `rel="noopener noreferrer"`. A disabled entry stays a disabled button.
  href?: string | undefined
  // Runs once the menu has closed, so a dialog it opens takes focus from the page rather than from a vanished menu. Optional on an entry with an `href`, which runs it as the link is followed.
  onSelect?: (() => unknown) | undefined
}

const WEB = /^https?:\/\//

// Whether a link leaves the page's origin: compared with the page's when it runs in a browser, any absolute web address otherwise.
export function opensOutside(href: string): boolean {
  if (typeof location === 'undefined')
    return WEB.test(href)

  try {
    return new URL(href, location.href).origin !== location.origin
  }
  catch {
    return false
  }
}

// An action, or a rule between groups of them.
export type MenuEntry = MenuAction | 'separator'
