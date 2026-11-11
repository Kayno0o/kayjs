import type { PopoverTriggerProps } from './popover'

// The roles a trigger announces with `aria-haspopup`; any other role leaves it off, as the attribute has no value for it.
const POPUPS = new Set(['dialog', 'menu', 'listbox', 'tree', 'grid'])

// The `aria-haspopup` value that matches a panel's role.
export function popupOf(role: string): PopoverTriggerProps['aria-haspopup'] {
  return POPUPS.has(role) ? role as PopoverTriggerProps['aria-haspopup'] : undefined
}
