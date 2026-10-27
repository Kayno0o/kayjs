import type { JSX } from 'kay'
import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'

// What BusyButton takes, which has no recipe: `variant`, `tone` and `size` are Button's recipe variants, repeated here for it.
export interface Look {
  // The form: `solid` is the framed button, `ghost` has no frame until hovered and `inline` reads as a link.
  variant?: 'solid' | 'ghost' | 'inline' | undefined
  // What the button means: `accent` for the main action, `success` for a confirming one, `danger` for a destructive one.
  tone?: 'neutral' | 'accent' | 'success' | 'danger' | undefined
  size?: 'xs' | 'sm' | 'md' | 'lg' | undefined
  // Drawn before the label.
  icon?: IconSlot | IconProps | undefined
  // Spins in place of the icon while what the press started is under way.
  // Left out, a button with an `onClick` is busy and disabled by itself while the promise it returned is pending, and a submit button is busy while its form's `onSubmit` returns one; given, `busy` has the last word.
  busy?: boolean | undefined
  // Whether `busy` shows the spinner; `false` keeps the icon and label while the button still holds itself busy and, with an `onClick`, disabled.
  spinner?: boolean | undefined
  label?: string | undefined
}

export type AsButton = Omit<JSX.IntrinsicElements['button'], 'type' | 'class'> & Look & {
  href?: undefined
  type?: 'button' | 'submit' | 'reset' | undefined
  // Whether the disclosure the button opens is showing, for a popover or a panel it toggles.
  expanded?: boolean | undefined
  // For a toggle button: whether it is on. Written as `aria-pressed`, and the button draws an accent keyline while it is.
  pressed?: boolean | undefined
}

// With an `href`, the button is a link looking like one, for an action that goes to another page.
export type AsLink = Omit<JSX.IntrinsicElements['a'], 'class'> & Look & {
  href: string
}

export type ButtonProps = AsButton | AsLink

// What the tag takes. A rest taken from a union merges its members, so the union is put back for `href` to tell them apart.
export type TagAttributes = Omit<AsButton, keyof Look> | Omit<AsLink, keyof Look>

export function linkOf(attributes: TagAttributes) {
  return attributes.href === undefined ? undefined : attributes
}

// A disabled button carrying a tooltip, whose reason the keyboard must reach: it is written `aria-disabled` and ignores the press rather than taking `disabled`, which drops it from the tab order.
export function lockedWithTooltip(attributes: TagAttributes) {
  const { disabled, 'data-tooltip': tooltip } = attributes as Record<string, unknown>

  return Boolean(disabled) && tooltip !== undefined
}

export function buttonOf(attributes: TagAttributes) {
  if (attributes.href !== undefined)
    return undefined

  const { type = 'button', expanded, pressed, disabled, ...others } = attributes
  const locked = lockedWithTooltip(attributes)

  // A locked submit or reset button turns plain, as nothing may submit or reset the form it sits in.
  return { ...others, 'type': locked ? 'button' : type, 'disabled': locked ? undefined : disabled, 'aria-disabled': locked ? 'true' : others['aria-disabled'], 'aria-expanded': expanded === undefined ? undefined : String(expanded), 'aria-pressed': pressed === undefined ? undefined : String(pressed) }
}
