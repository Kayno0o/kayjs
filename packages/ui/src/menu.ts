import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'
import type { NewTab } from './outside'
import type { PopoverTriggerProps } from './popover'
import type { Tone } from './tone'

// What every entry that can be picked shares.
export interface MenuItemBase {
  label: string
  icon?: IconSlot | IconProps
  // Colours the entry, such as `danger` for a destructive one.
  tone?: Tone | undefined
  /** @deprecated Use `tone: 'danger'`, which wins when both are given. Removed in 2.0.0. */
  danger?: boolean
  disabled?: boolean
  // Text hinting the key combination that does the same elsewhere, such as `Ctrl+S`, drawn at the end of the row. It binds nothing: kay's `shortcut()` does.
  shortcut?: string | undefined
  // Keeps the menu open once the entry is picked (`false`), such as to flip several options in a row; `true` by default, so the menu closes and `onSelect` runs after it.
  closeOnSelect?: boolean | undefined
}

export interface MenuAction extends MenuItemBase {
  // Draws the entry as a link, so it takes a middle-click, Ctrl+click and "copy link"; the menu closes once it is followed. An absolute address (`https://...`) opens in a new tab with `rel="noopener noreferrer"`, which `newTab` overrides. A disabled entry stays a disabled button.
  href?: string | undefined
  // Opens the link in a new tab (`true`), the same one (`false`), or a new one when the address leaves the site (`'auto'`, the default).
  newTab?: NewTab | undefined
  // Runs once the menu has closed, so a dialog it opens takes focus from the page rather than from a vanished menu. Optional on an entry with an `href`, which runs it as the link is followed.
  onSelect?: (() => unknown) | undefined
}

// A `role="menuitemcheckbox"` entry. The app holds its state with `checked` and learns of a change in `onCheckedChange`, or leaves `checked` out and the menu keeps it, starting from `defaultChecked`.
export interface MenuCheckbox extends MenuItemBase {
  checked?: boolean | undefined
  defaultChecked?: boolean | undefined
  onCheckedChange?: ((checked: boolean) => unknown) | undefined
}

// A `role="menuitemradio"` entry: of the entries sharing a `radioGroup`, one is checked. The app holds the state with `checked` on each, or leaves it out and the menu keeps the group's value, starting from the entry with `defaultChecked`; `onCheckedChange` hears the `value` of the entry that became the checked one.
export interface MenuRadio extends MenuItemBase {
  radioGroup: string
  value: string
  checked?: boolean | undefined
  defaultChecked?: boolean | undefined
  onCheckedChange?: ((value: string) => unknown) | undefined
}

// The entries a menu draws: a list, a function returning one or a promise of one.
export type MenuSource = MenuEntry[] | (() => MenuEntry[] | Promise<MenuEntry[]>) | Promise<MenuEntry[]>

// An entry opening a menu of its own, with ArrowRight or a click, and closing it with ArrowLeft; its entries come from a list or an async source like the menu's.
export interface MenuSubmenu {
  label: string
  icon?: IconSlot | IconProps
  tone?: Tone | undefined
  disabled?: boolean
  items: MenuSource
}

// A title over the entries that follow it.
export interface MenuHeading {
  heading: string
}

// What an `@item` snippet is handed: an entry that can be picked.
export type MenuItem = MenuAction | MenuCheckbox | MenuRadio | MenuSubmenu

// An entry, a heading, or a rule between groups of them.
export type MenuEntry = MenuItem | MenuHeading | 'separator'

export function headingOf(entry: MenuEntry): MenuHeading | undefined {
  return typeof entry === 'object' && 'heading' in entry ? entry : undefined
}

export function submenuOf(entry: MenuEntry): MenuSubmenu | undefined {
  return typeof entry === 'object' && 'items' in entry ? entry : undefined
}

export function radioOf(entry: MenuEntry): MenuRadio | undefined {
  return typeof entry === 'object' && 'radioGroup' in entry ? entry : undefined
}

export function checkboxOf(entry: MenuEntry): MenuCheckbox | undefined {
  return typeof entry === 'object' && !('radioGroup' in entry) && ('checked' in entry || 'defaultChecked' in entry || 'onCheckedChange' in entry) ? entry : undefined
}

// An entry that is none of the others: a button, or a link.
export function actionOf(entry: MenuEntry): MenuAction | undefined {
  return typeof entry === 'object' && !headingOf(entry) && !submenuOf(entry) && !radioOf(entry) && !checkboxOf(entry) ? entry as MenuAction : undefined
}

// What a `@trigger` snippet of a Menu is handed: the popover's trigger attributes with the role of what they open, to spread on any element.
export type MenuTriggerProps = PopoverTriggerProps & { 'aria-haspopup': 'menu' | 'true' }

// Adds `aria-haspopup` to the attributes while keeping `aria-expanded` a getter, so a spread of the result still follows the panel.
export function withPopup(attributes: PopoverTriggerProps, popup: MenuTriggerProps['aria-haspopup']): MenuTriggerProps {
  return Object.defineProperty(Object.defineProperties({}, Object.getOwnPropertyDescriptors(attributes)), 'aria-haspopup', { value: popup, enumerable: true }) as MenuTriggerProps
}
