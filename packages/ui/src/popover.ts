import type { JSX } from 'kay'

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

// The attributes of a component's floating panel, as its `panelProps` takes them: the panel is a `div` whose id, role, popover state and class the component owns.
export type PopoverPanelProps = Omit<JSX.IntrinsicElements['div'], 'id' | 'popover' | 'class' | 'children' | 'onToggle' | 'role' | 'style'> & {
  // Written after the component's own declarations, so it wins.
  style?: string | undefined
}

// The attributes of the button a component draws to open its panel, as its `triggerProps` takes them: what opens the panel, says whether it shows and anchors it stays the component's.
export type PopoverButtonProps = Omit<JSX.IntrinsicElements['button'], 'class' | 'children' | 'type' | 'popovertarget' | 'aria-expanded' | 'style'>
