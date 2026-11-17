import type { Placement } from './popover'

// The name `Placement` replaces, kept as an alias for three minors.
export type HoverCardPlacement = Placement

// What a HoverCard's `@trigger(attributes)` block spreads onto the element the card is for: the handlers that show and hide it, and the card's anchor.
export interface HoverCardTriggerProps {
  'onPointerEnter': (event: PointerEvent) => void
  'onPointerLeave': () => void
  'onFocus': (event: FocusEvent) => void
  'onBlur': () => void
  'data-hover-card': string
}
