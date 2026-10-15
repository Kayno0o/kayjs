import type { JSX } from 'kay'
import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'

export interface Look {
  variant?: 'default' | 'accent' | 'danger' | undefined
  // Drawn before the label.
  icon?: IconSlot | IconProps | undefined
  // Spins in place of the icon while what the press started is under way.
  // Left out, a button with an `onClick` is busy and disabled by itself while the promise it returned is pending, and a submit button is busy while its form's `onSubmit` returns one; given, `busy` has the last word.
  busy?: boolean | undefined
  label?: string | undefined
  class?: string | undefined
}

export type AsButton = Omit<JSX.IntrinsicElements['button'], 'type' | 'class'> & Look & {
  href?: undefined
  type?: 'button' | 'submit' | 'reset' | undefined
  // Whether the disclosure the button opens is showing, for a popover or a panel it toggles.
  expanded?: boolean | undefined
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

export function buttonOf(attributes: TagAttributes) {
  if (attributes.href !== undefined)
    return undefined

  const { type = 'button', expanded, ...others } = attributes

  return { ...others, 'type': type, 'aria-expanded': expanded === undefined ? undefined : String(expanded) }
}

export function lookOf(variant: Look['variant'], className: string | undefined) {
  return [{ 'kui-btn-accent': variant === 'accent', 'kui-btn-danger': variant === 'danger' }, className]
}
