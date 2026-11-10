import { markInvalid } from 'kay'
import { liveElements } from './field-look'

// What a FormField's label names in its slot: the first control taking focus.
export const CONTROL = 'input:not([type="hidden"]), select, textarea, button, [contenteditable], [tabindex]'

// What marks the root of a choice group (RadioGroup, Segmented, ChipGroup, Rating, RangeInput), the one element of the field a FormField names, describes and marks invalid.
export const CHOICE = '[data-kui-choice]'

const SPACES = /\s+/
const SPOKEN = ':scope > [data-part="hint"][id], :scope > [data-part="issues"][id]'

// The element a FormField's label names: the choice group inside it, else the first control taking focus.
export function controlOf(label: Element | null | undefined): HTMLElement | null {
  return label?.querySelector<HTMLElement>(CHOICE) ?? label?.querySelector<HTMLElement>(CONTROL) ?? null
}

// Links a choice group to the static FormField around it once the browser has the group: a group is an island, so the server cannot hand it the field's label, hint and message, and a label around several inputs names none of them.
// A FormField running in the browser keeps the link itself, `paintIssues` the messages of a refused call, and one with `group` names its own fields.
export function linkChoice(root: HTMLElement | null | undefined): void {
  const frame = root?.closest('[data-kui-field]')

  if (!root || !frame || frame.tagName === 'FIELDSET' || liveElements.has(frame) || controlOf(frame.querySelector(':scope > label')) !== root)
    return

  const text = frame.querySelector(':scope > label [data-part="text"]')

  if (text !== null && text.id !== '' && !root.hasAttribute('aria-label') && !root.hasAttribute('aria-labelledby'))
    root.setAttribute('aria-labelledby', text.id)

  const own = (root.getAttribute('aria-describedby') ?? '').split(SPACES).filter(id => id !== '')
  const spoken = [...frame.querySelectorAll(SPOKEN)]
  const ids = [...own, ...spoken.map(element => element.id).filter(id => !own.includes(id))]

  if (ids.length > 0)
    root.setAttribute('aria-describedby', ids.join(' '))

  if (spoken.some(element => element.getAttribute('data-part') === 'issues'))
    markInvalid(root, linkChoice, true)

  if (text?.querySelector('[data-part="required"]') && root.getAttribute('role') === 'radiogroup' && !root.hasAttribute('aria-required'))
    root.setAttribute('aria-required', 'true')
}
