import { context, describeField, effect, uid } from 'kay'

// The messages a FormDialog's last call was refused with, by field name, which each FormField inside it reads for its own `name`.
export const formIssues = context<(() => Record<string, string>) | undefined>(undefined)

// What a FormField's label names in its slot: the first control taking focus.
const CONTROL = 'input:not([type="hidden"]), select, textarea, button, [contenteditable], [tabindex]'
// What a group marks while its message shows: the fields of the group, which take `aria-invalid`, not the buttons of a picker.
const FIELDS = 'input:not([type="hidden"]), select, textarea'
const SPACES = /\s+/

export interface FieldLinks {
  // Marks the field's frame, for the link to find its control: a `ref` would make the component an island.
  frame: string
  hint: string
  issues: string
  // What describes the field: the hint, and the messages while there are any.
  described: () => string[]
}

// A FormField's ids, and the link from its control to its hint and messages: kept in the control's `aria-describedby` beside the page's own ids, and `aria-invalid` while a message shows.
// A group has no control of its own: while a message shows, each field in it is marked invalid and described by the message, so `focusInvalid` reaches the group's first field.
// The control is the page's own markup: the server hands it the ids as it renders, and inside an island the browser keeps the link as the messages change; drawn here rather than in the component, which stays static on a page of its own.
export function fieldLinks(group: boolean, hint: boolean, messages: () => readonly unknown[]): FieldLinks {
  const links: FieldLinks = { frame: uid(), hint: uid(), issues: uid(), described: () => [hint ? links.hint : undefined, messages().length > 0 ? links.issues : undefined].filter(id => id !== undefined) }

  // A static page renders the field outside any island, where nothing drops the effect as an island's server render does.
  if (typeof document === 'undefined') {
    describeField(group ? '' : links.described().join(' '))

    return links
  }

  let marked = false
  const touchedFields = new Map<HTMLElement, boolean>()

  effect(() => {
    if (group) {
      markGroup(links, messages().length > 0, touchedFields)

      return
    }

    const ours = links.described()
    const invalid = messages().length > 0
    const control = document.querySelector(`[data-kui-field="${links.frame}"] .kui-form-field-label`)?.querySelector<HTMLElement>(CONTROL)

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

// The map tells whether the group set `aria-invalid` itself, so one the page marked is left as it is when the message clears.
function markGroup(links: FieldLinks, shown: boolean, touched: Map<HTMLElement, boolean>): void {
  const fields = shown ? [...document.querySelectorAll<HTMLElement>(`[data-kui-field="${links.frame}"] :is(${FIELDS})`)].filter(field => field.closest('[data-kui-field]')?.getAttribute('data-kui-field') === links.frame) : [...touched.keys()]

  for (const field of fields) {
    const own = (field.getAttribute('aria-describedby') ?? '').split(SPACES).filter(id => id !== '' && id !== links.issues)

    if (shown) {
      field.setAttribute('aria-describedby', [...own, links.issues].join(' '))
      touched.set(field, touched.get(field) ?? field.getAttribute('aria-invalid') !== 'true')
      field.setAttribute('aria-invalid', 'true')

      continue
    }

    if (own.length > 0)
      field.setAttribute('aria-describedby', own.join(' '))
    else
      field.removeAttribute('aria-describedby')

    if (touched.get(field))
      field.removeAttribute('aria-invalid')

    touched.delete(field)
  }
}
