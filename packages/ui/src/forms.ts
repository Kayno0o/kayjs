import type { Action, Answer, FailureData, Signal, Success } from 'kay'
import { ActionError, createContext, describeField, effect, focusInvalid, formErrors, markInvalid, uid, untrack } from 'kay'
import { liveElements } from './field-look'
import { answerMessage } from './internal/answer-message'
import { toast } from './toast'

// The name of the FormField around a control, which shows that field's messages: a Checkbox or Toggle of the same name leaves them to it.
export const fieldNamed = createContext<(() => string | undefined) | undefined>(undefined)

// The messages a FormDialog's last call was refused with, by field name, which each FormField inside it reads for its own `name`.
export const formIssues = createContext<(() => Record<string, string>) | undefined>(undefined)

// What a FormField's label names in its slot: the first control taking focus.
export const CONTROL = 'input:not([type="hidden"]), select, textarea, button, [contenteditable], [tabindex]'
// What a group marks while its message shows: the fields of the group, which take `aria-invalid`, not the buttons of a picker.
const FIELDS = 'input:not([type="hidden"]), select, textarea'
const SPACES = /\s+/

// The fields whose `aria-required` was set here, not by the page.
const requiredByUs = new WeakSet<HTMLElement>()

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
export function fieldLinks(group: () => boolean, hint: () => boolean, messages: () => readonly unknown[], required: () => boolean = () => false): FieldLinks {
  const links: FieldLinks = { frame: uid(), hint: uid(), issues: uid(), described: () => [hint() ? links.hint : undefined, messages().length > 0 ? links.issues : undefined].filter(id => id !== undefined) }

  // A static page renders the field outside any island, where nothing drops the effect as an island's server render does.
  if (typeof document === 'undefined') {
    describeField(group() ? '' : links.described().join(' '), { required: required() && (group() ? 'all' : true) })

    return links
  }

  const marked = new Set<HTMLElement>()
  let grouped = false
  let claimed = false

  effect(() => {
    // Told to the painter of a static page's fields, which leaves this one to draw its own messages.
    if (!claimed) {
      const frame = document.querySelector(`[data-kui-field="${links.frame}"]`)

      if (frame) {
        liveElements.add(frame)
        claimed = true
      }
    }

    if (group()) {
      grouped = true
      markGroup(links, messages().length > 0, marked, required())

      return
    }

    // A group that became a single field leaves nothing marked behind, nor the `aria-required` it set.
    if (grouped) {
      grouped = false
      markGroup(links, false, marked, false)

      for (const field of fieldsOf(links.frame)) {
        if (requiredByUs.delete(field))
          field.removeAttribute('aria-required')
      }
    }

    const ours = links.described()
    const invalid = messages().length > 0
    const control = document.querySelector(`[data-kui-field="${links.frame}"] > label`)?.querySelector<HTMLElement>(CONTROL)

    if (!control)
      return

    const own = (control.getAttribute('aria-describedby') ?? '').split(SPACES).filter(id => id !== '' && id !== links.hint && id !== links.issues)
    const all = [...own, ...ours]

    if (all.length > 0)
      control.setAttribute('aria-describedby', all.join(' '))
    else
      control.removeAttribute('aria-describedby')

    if (required())
      requireField(control)

    markInvalid(control, links, invalid)
  })

  return links
}

// The fields of the group itself, those of a FormField nested in it left to that one.
export function fieldsOf(frame: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-kui-field="${frame}"] :is(${FIELDS})`)].filter(field => field.closest('[data-kui-field]')?.getAttribute('data-kui-field') === frame)
}

// The input types whose role takes no `aria-required`.
const UNREQUIRABLE = new Set(['radio', 'range', 'file', 'color'])

function requireField(field: HTMLElement): void {
  if (!field.hasAttribute('aria-required') && !(field instanceof HTMLInputElement && UNREQUIRABLE.has(field.type))) {
    field.setAttribute('aria-required', 'true')
    requiredByUs.add(field)
  }
}

// The fields the group marked, which it clears once its message does; `markInvalid` leaves one the page or a refused post still marks.
function markGroup(links: FieldLinks, shown: boolean, marked: Set<HTMLElement>, required: boolean): void {
  for (const field of fieldsOf(links.frame)) {
    if (required)
      requireField(field)

    // A field that was a single control still names the hint, which the group's own element carries now.
    const described = (field.getAttribute('aria-describedby') ?? '').split(SPACES)

    if (described.includes(links.hint)) {
      const rest = described.filter(id => id !== '' && id !== links.hint)

      if (rest.length > 0)
        field.setAttribute('aria-describedby', rest.join(' '))
      else
        field.removeAttribute('aria-describedby')
    }
  }

  const fields = shown ? fieldsOf(links.frame) : [...marked]

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
export async function callAction<Output>(form: HTMLFormElement, action: Action<never, Output>, issues: Signal<Record<string, string>>, failure: string, refused?: ((data: FailureData<Output>) => Record<string, string> | string | undefined) | undefined, onError?: ((failure: { error: unknown }) => unknown) | undefined): Promise<{ result: Answer<Success<Output>> } | undefined> {
  try {
    return { result: await action(new FormData(form)) }
  }
  catch (error) {
    // Told first, before the toast, what the call was refused or failed with.
    try {
      onError?.({ error })
    }
    catch (thrown) {
      console.error('kayjs-ui: an onError callback threw', thrown)
    }

    const read = error instanceof ActionError && error.data !== undefined ? refused?.(error.data as FailureData<Output>) : undefined
    // As in `attempt`, a `refused` saying nothing leaves the words of the data itself.
    const said = read === undefined || read === '' ? answerMessage(error instanceof ActionError ? error.data : undefined) : read

    await refuse(form, { ...error instanceof ActionError ? error.errors : {}, ...messagesOf(said) }, issues, failure)

    return undefined
  }
}

// Shows a refusal: the messages go to the FormFields, a message no FormField shows (a limit, or a refusal of the whole form under the empty name) is toasted rather than lost, a refusal carrying none toasts `failure`, and the first invalid field takes the focus.
async function refuse(form: HTMLFormElement, byField: Record<string, string>, issues: Signal<Record<string, string>>, failure: string): Promise<void> {
  const messages = Object.entries(byField)

  issues.set(byField)

  const painted = await showIssues(form, byField)
  // A painter that could not load shows nothing, so every message is toasted rather than lost.
  const shown = (name: string) => painted && [...form.querySelectorAll('[data-field]')].some(field => field.getAttribute('data-field') === name)

  for (const message of messages.length === 0 ? [failure] : messages.filter(([name]) => !shown(name)).map(([, message]) => message))
    toast.error(message)

  // Each FormField marks its control invalid as its message renders; the first one takes the focus, so the message is read with it.
  await focusInvalid(form)
}

// What `checkSchema` asks of an action: `validate` and the errors of `failed()`.
interface Validating {
  validate: (form: HTMLFormElement, field?: string) => Promise<boolean>
  failed: () => { errors: object } | undefined
}

// What a form's `validate` is: `'submit'` checks the fields against the action's schema when the form is sent, `'blur'` also each field as it loses focus, `false` leaves it to the server.
export type FormValidation = 'blur' | 'submit' | false | undefined

// The name of the field a focus left, none for a button or a control without one.
export function leftField(event: FocusEvent): string | undefined {
  const control = event.target

  return (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) && control.name !== '' ? control.name : undefined
}

// `checkSchema` for a send, `checking` set meanwhile: the first use fetches the check, and a second send meanwhile (a double Enter, Ctrl+S twice) is the form's to refuse.
export async function checkSent(form: HTMLFormElement, action: Validating, issues: Signal<Record<string, string>>, failure: string, checking: Signal<boolean>): Promise<boolean> {
  checking.set(true)

  try {
    return await checkSchema(form, action, issues, failure)
  }
  finally {
    checking.set(false)
  }
}

// Checks the form against the action's schema in the browser, as the server would, and puts the messages where a refusal's go. Sent, a refusal shows as a call's does and nothing is called; with a `field`, the one that lost focus, only its message changes and the focus stays. True when what was checked is accepted.
export async function checkSchema(form: HTMLFormElement, action: Validating, issues: Signal<Record<string, string>>, failure: string, field?: string): Promise<boolean> {
  try {
    const accepted = await action.validate(form, field)
    const errors = { ...untrack(action.failed)?.errors } as Record<string, string>

    if (field === undefined && !accepted) {
      await refuse(form, errors, issues, failure)
    }
    else {
      issues.set(errors)
      await showIssues(form, errors)
    }

    return accepted
  }
  catch (error) {
    // A check that cannot run leaves the form to the server.
    console.error('kayjs-ui: the form could not be checked', error)

    return true
  }
}

// Writes the messages into the FormFields a static page gave the form as children, which no script of theirs reaches in the browser; the ones inside an island draw their own. The code is a chunk of its own, fetched only for a form that holds such a field and has a message to put or take away.
// False when the messages could not be shown, the chunk failing to load.
export async function showIssues(form: HTMLFormElement, byField: Record<string, string>): Promise<boolean> {
  const fields = [...form.querySelectorAll('[data-field]')].filter((field) => {
    const frame = field.closest('[data-kui-field]')

    return !frame || !liveElements.has(frame)
  })

  if (fields.length === 0 || (Object.keys(byField).length === 0 && form.querySelectorAll('[data-form-issue]').length === 0))
    return true

  try {
    (await import('./internal/paint-issues')).paintIssues(form, byField)

    return true
  }
  catch (error) {
    console.error('kayjs-ui: the messages of a form could not be shown', error)

    return false
  }
}

// The messages shown for one field: those its form's last call was refused with under `name`, else the one its `form(action)` holds for it, then the page's own `issue`, none twice and none empty. Read in a component's script, where the form's context is.
// A Form, FormDialog or SaveForm gives `formIssues` and clears it itself, so the action's own error, which stays until a call succeeds, is not read beside it.
export function fieldIssues(name: () => string | undefined, issue: () => string | undefined): () => string[] {
  const list = fieldIssueList(name, issue)

  return () => list().map(item => item.message)
}

// One message of a field, and whether the form gave it: the page's own `issue` is not, and a form's message the page's `issue` repeats is the page's.
export interface FieldIssue {
  message: string
  form: boolean
}

// `fieldIssues` told apart by who gave each message, for a static page to replace the form's alone.
export function fieldIssueList(name: () => string | undefined, issue: () => string | undefined): () => FieldIssue[] {
  const refused = formIssues.use()
  const held = formErrors()
  const read = (field: string) => refused ? refused()[field] : held(field)

  return () => {
    const field = name()
    const given = issue()
    const formed = field === undefined ? undefined : read(field)
    const found: FieldIssue[] = []

    if (formed !== undefined && formed !== '' && formed !== given)
      found.push({ message: formed, form: true })

    if (given !== undefined && given !== '')
      found.push({ message: given, form: false })

    return found
  }
}
