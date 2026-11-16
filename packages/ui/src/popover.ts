import type { JSX } from 'kay'
import type { Look } from './button-props'

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

// The attributes of a component's floating panel, as its `panelProps` takes them: the id, role, popover state, visibility and class stay the component's. An event handler runs before the component's own for the same event.
export type PanelProps<Tag extends 'div' | 'ul' = 'div'> = Omit<JSX.IntrinsicElements[Tag], 'id' | 'popover' | 'class' | 'children' | 'onToggle' | 'role' | 'hidden' | 'style'> & {
  // Written after the component's own declarations, so it wins.
  style?: string | undefined
}

// The panel of a Popover, a `div`.
export type PopoverPanelProps = PanelProps

// The attributes of the button a component draws to open its panel, as its `triggerProps` takes them: what opens the panel, says whether it shows and anchors it stays the component's.
export type PopoverButtonProps = Omit<JSX.IntrinsicElements['button'], 'class' | 'children' | 'id' | 'type' | 'popovertarget' | 'aria-expanded' | 'style'>

// The same for a Button or an IconButton, which also takes its `variant`, `size` and `label`: the app's win over the component's.
export type PopoverLookButtonProps = PopoverButtonProps & Pick<Look, 'variant' | 'size' | 'label'>
