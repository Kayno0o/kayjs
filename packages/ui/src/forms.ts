import { context, effect, uid } from 'kay'

// The messages a FormDialog's last call was refused with, by field name, which each FormField inside it reads for its own `name`.
export const formIssues = context<(() => Record<string, string>) | undefined>(undefined)

// What a FormField's label names in its slot: the first control taking focus.
const CONTROL = 'input:not([type="hidden"]), select, textarea, button, [contenteditable], [tabindex]'
const SPACES = /\s+/

export interface FieldLinks {
  // Marks the field's frame, for the link to find its control.
  frame: string
  hint: string
  issues: string
  // What describes the field: the hint, and the messages while there are any.
  described: () => string[]
}

// A FormField's ids, and the link from its control to its hint and messages: kept in the control's `aria-describedby` beside the page's own ids, and `aria-invalid` while a message shows.
// The control is the page's own markup, so the link runs in the browser, wherever the field renders inside an island; drawn here rather than in the component, which stays static on a page of its own.
export function fieldLinks(group: boolean, hint: boolean, messages: () => readonly unknown[]): FieldLinks {
  const links: FieldLinks = { frame: uid(), hint: uid(), issues: uid(), described: () => [hint ? links.hint : undefined, messages().length > 0 ? links.issues : undefined].filter(id => id !== undefined) }

  // A static page renders the field outside any island, where nothing drops the effect as an island's server render does.
  if (typeof document === 'undefined')
    return links

  let marked = false

  effect(() => {
    const ours = links.described()
    const invalid = messages().length > 0
    const control = group ? undefined : document.querySelector(`[data-kui-field="${links.frame}"] .kui-form-field-label`)?.querySelector<HTMLElement>(CONTROL)

    if (!control)
      return

    const own = (control.getAttribute('aria-describedby') ?? '').split(SPACES).filter(id => id !== '' && id !== links.hint && id !== links.issues)
    const all = [...own, ...ours]

    if (all.length > 0)
      control.setAttribute('aria-describedby', all.join(' '))
    else
      control.removeAttribute('aria-describedby')

    if (invalid) {
      marked = control.getAttribute('aria-invalid') !== 'true' || marked
      control.setAttribute('aria-invalid', 'true')
    }
    else if (marked) {
      marked = false
      control.removeAttribute('aria-invalid')
    }
  })

  return links
}
