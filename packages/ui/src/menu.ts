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

// A `role="menuitemcheckbox"` entry: an entry carrying `checked`, `defaultChecked` or `onCheckedChange` is one. The app holds its state with `checked` and learns of a change in `onCheckedChange`, or leaves `checked` out and the menu keeps it, starting from `defaultChecked`. The menu keeps it under `id`, else under the entry's position in the list, so give an `id` to an entry that can move.
export interface MenuCheckbox extends MenuItemBase {
  id?: string | undefined
  checked?: boolean | undefined
  defaultChecked?: boolean | undefined
  onCheckedChange?: ((checked: boolean) => unknown) | undefined
}

// A `role="menuitemradio"` entry: an entry with a `radioGroup` is one, and of the entries sharing it one is checked. The app holds the state with `checked` on each, or leaves it out and the menu keeps the group's value, starting from the entry with `defaultChecked`: with neither, nothing is checked until one is picked. `onCheckedChange` hears the `value` of the entry that became the checked one.
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
  // Shows the submenu when the page sets it, and `onOpenChange` hears it open and close, as the menu's own do; left out, the menu opens and closes it.
  open?: boolean | undefined
  onOpenChange?: ((open: boolean) => unknown) | undefined
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

// What a row of entries needs to be announced in groups: a heading owns the entries up to the next heading or rule, and the radios sharing a `radioGroup` in that stretch sit in a group of their own, drawn before the first of them.
export interface MenuGroups {
  // A heading's owned ids.
  owns: Map<number, string>
  // The first radio of a group: the owned ids of its group, and the heading naming it.
  radios: Map<number, { owns: string, labelledby: string | undefined }>
}

export function menuGroups(entries: readonly MenuEntry[], menuId: string): MenuGroups {
  const owns = new Map<number, string[]>()
  const radios = new Map<number, { owns: string[], labelledby: string | undefined }>()
  let heading: number | undefined
  let seen = new Map<string, number>()

  for (const [index, entry] of entries.entries()) {
    if (entry === 'separator' || headingOf(entry)) {
      heading = entry === 'separator' ? undefined : index
      seen = new Map()

      if (heading !== undefined)
        owns.set(heading, [])

      continue
    }

    const radio = radioOf(entry)
    const itemId = `${menuId}-item-${index}`

    if (!radio) {
      if (heading !== undefined)
        owns.get(heading)!.push(itemId)

      continue
    }

    const first = seen.get(radio.radioGroup)

    if (first === undefined) {
      seen.set(radio.radioGroup, index)
      radios.set(index, { owns: [itemId], labelledby: heading === undefined ? undefined : `${menuId}-heading-${heading}` })

      if (heading !== undefined)
        owns.get(heading)!.push(`${menuId}-group-${index}`)
    }
    else {
      radios.get(first)!.owns.push(itemId)
    }
  }

  return { owns: new Map([...owns].map(([index, ids]) => [index, ids.join(' ')])), radios: new Map([...radios].map(([index, group]) => [index, { owns: group.owns.join(' '), labelledby: group.labelledby }])) }
}
