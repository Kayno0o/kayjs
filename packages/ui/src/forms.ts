import type { Action, Answer, FailureData, Signal, Success } from 'kay'
import { ActionError, context, describeField, effect, focusInvalid, markInvalid, uid } from 'kay'
import { toast } from './toast'

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
// A required field's control, each field of a group, takes `aria-required` unless the page set one, since the star beside the label is hidden from a screen reader.
// A group has no control of its own: while a message shows, each field in it is marked invalid and described by the message, so `focusInvalid` reaches the group's first field.
// The control is the page's own markup: the server hands it the ids as it renders, and inside an island the browser keeps the link as the messages change; drawn here rather than in the component, which stays static on a page of its own.
export function fieldLinks(group: boolean, hint: boolean, messages: () => readonly unknown[], required = false): FieldLinks {
  const links: FieldLinks = { frame: uid(), hint: uid(), issues: uid(), described: () => [hint ? links.hint : undefined, messages().length > 0 ? links.issues : undefined].filter(id => id !== undefined) }

  // A static page renders the field outside any island, where nothing drops the effect as an island's server render does.
  if (typeof document === 'undefined') {
    describeField(group ? '' : links.described().join(' '))

    return links
  }

  if (group) {
    const marked = new Set<HTMLElement>()

    effect(() => markGroup(links, messages().length > 0, marked, required))

    return links
  }

  effect(() => {
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

    if (required)
      requireField(control)

    markInvalid(control, links, invalid)
  })

  return links
}

// The fields of the group itself, those of a FormField nested in it left to that one.
function fieldsOf(links: FieldLinks): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-kui-field="${links.frame}"] :is(${FIELDS})`)].filter(field => field.closest('[data-kui-field]')?.getAttribute('data-kui-field') === links.frame)
}

function requireField(field: HTMLElement): void {
  if (!field.hasAttribute('aria-required'))
    field.setAttribute('aria-required', 'true')
}

// The fields the group marked, which it clears once its message does; `markInvalid` leaves one the page or a refused post still marks.
function markGroup(links: FieldLinks, shown: boolean, marked: Set<HTMLElement>, required: boolean): void {
  if (required) {
    for (const field of fieldsOf(links))
      requireField(field)
  }

  const fields = shown ? fieldsOf(links) : [...marked]

  for (const field of fields) {
    const own = (field.getAttribute('aria-describedby') ?? '').split(SPACES).filter(id => id !== '' && id !== links.issues)

    if (shown) {
      field.setAttribute('aria-describedby', [...own, links.issues].join(' '))
      marked.add(field)
      markInvalid(field, links, true)

      continue
    }

    if (own.length > 0)
      field.setAttribute('aria-describedby', own.join(' '))
    else
      field.removeAttribute('aria-describedby')

    markInvalid(field, links, false)
    marked.delete(field)
  }
}

// What a handler's refusal says by field name: a single message goes under the empty name, as the whole form's.
function messagesOf(said: Record<string, string> | string | undefined): Record<string, string> | undefined {
  if (typeof said !== 'string')
    return said

  return said === '' ? {} : { '': said }
}

// Calls the action with the form's fields. A refusal sets the messages for each FormField, toasts the ones no field shows (or `failure` when it carries none) and focuses the first invalid field, answering undefined; what the action returned is answered inside an object, so a result of undefined is told apart.
// The schema refuses fields; the handler refuses with data of its own, which `refused` reads, a single message going under the empty name as the whole form's.
export async function callAction<Output>(form: HTMLFormElement, action: Action<never, Output>, issues: Signal<Record<string, string>>, failure: string, refused?: ((data: FailureData<Output>) => Record<string, string> | string | undefined) | undefined): Promise<{ result: Answer<Success<Output>> } | undefined> {
  try {
    return { result: await action(new FormData(form)) }
  }
  catch (error) {
    const said = error instanceof ActionError && error.data !== undefined ? refused?.(error.data as FailureData<Output>) : undefined
    const byField = { ...error instanceof ActionError ? error.errors : {}, ...messagesOf(said) }
    const messages = Object.entries(byField)
    const shown = (name: string) => [...form.querySelectorAll('[data-field]')].some(field => field.getAttribute('data-field') === name)

    issues.set(byField)

    // A message no FormField shows, such as a limit or a refusal of the whole form under the empty name, is toasted rather than lost; a failure carrying none toasts the page's own message.
    for (const message of messages.length === 0 ? [failure] : messages.filter(([name]) => !shown(name)).map(([, message]) => message))
      toast.error(message)

    // Each FormField marks its control invalid as its message renders; the first one takes the focus, so the message is read with it.
    await focusInvalid(form)

    return undefined
  }
}
