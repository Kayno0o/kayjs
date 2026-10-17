import type { JSX } from 'kay'
import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'

// Repeated in button.kay, which the docs read the props of: a prop is listed from the file declaring it.
export interface Look {
  // The form: `solid` is the framed button, `ghost` has no frame until hovered and `inline` reads as a link. `default`, `accent` and `danger` are deprecated: use `tone` for the last two, and `solid` for the first.
  variant?: 'solid' | 'ghost' | 'inline' | 'default' | 'accent' | 'danger' | undefined
  // What the button means: `accent` for the main action, `danger` for a destructive one.
  tone?: 'neutral' | 'accent' | 'danger' | undefined
  size?: 'xs' | 'sm' | 'md' | 'lg' | undefined
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

// The form a `variant` names: the three it used to hold for the meaning are the plain solid button.
export function formOf(variant: Look['variant']): 'solid' | 'ghost' | 'inline' {
  return variant === 'ghost' || variant === 'inline' ? variant : 'solid'
}

// The meaning: a `tone` has the last word over the `variant` that used to carry it.
export function toneOf(variant: Look['variant'], tone: Look['tone']): 'neutral' | 'accent' | 'danger' {
  if (tone !== undefined)
    return tone

  return variant === 'accent' || variant === 'danger' ? variant : 'neutral'
}

export function lookOf(variant: Look['variant'], tone: Look['tone'], className: string | undefined) {
  const meant = toneOf(variant, tone)

  return [{ 'kui-btn-accent': meant === 'accent', 'kui-btn-danger': meant === 'danger' }, className]
}
