export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start'

// What the panel is to assistive technology: a `dialog` by default, `menu`, `listbox`, `tree` or `grid` for a panel that is one, any other ARIA role such as `group`, or `none` when the panel only holds content that carries its own role.
export type PopoverRole = 'dialog' | 'menu' | 'listbox' | 'tree' | 'grid' | 'group' | 'region' | 'none' | (string & {})

// What a Popover's `@trigger(attributes)` block spreads onto its button: what opens the panel, says whether it shows, and anchors it.
export interface PopoverTriggerProps {
  'popovertarget': string
  'aria-expanded': 'true' | 'false'
  // The kind of panel it opens, from the Popover's `role`; absent for a role with no popup value.
  'aria-haspopup'?: 'dialog' | 'menu' | 'listbox' | 'tree' | 'grid' | 'true' | undefined
  'style': string
}
