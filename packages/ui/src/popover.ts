export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

// What a Popover's `@trigger(attributes)` block spreads onto its button: what opens the panel, says whether it shows, and anchors it.
export interface PopoverTriggerProps {
  'popovertarget': string
  'aria-expanded': 'true' | 'false'
  'style': string
}
