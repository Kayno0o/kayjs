import { describeField, effect, formErrors, markInvalid, uid } from 'kay'
import { CHOICE, CONTROL, controlOf } from './choice-link'
import { liveElements } from './field-look'
import { fieldNamed, formIssues } from './form-context'

export { fieldNamed, formIssues }
export { CONTROL, controlOf }

// What a group marks while its message shows: the fields of the group, which take `aria-invalid`, not the buttons of a picker.
const FIELDS = 'input:not([type="hidden"]), select, textarea'
const SPACES = /\s+/
const ITEM = /^(?:\.\d+|\[\d+\])$/

// The fields whose `aria-required` or `required` was set here, not by the page.
const requiredByUs = new WeakSet<HTMLElement>()
const nativeByUs = new WeakSet<HTMLElement>()
// The controls whose mark the server drew for a message was looked at.
const looked = new WeakSet<HTMLElement>()

// The mark the server drew for this FormField's message, found with the message's id in the `aria-describedby` of the control, or of the group around the field, is kay's and not the page's: it goes, for the FormField to hold its own, so it clears with the message.
function releaseServerMark(control: HTMLElement, links: FieldLinks, described: Element = control): void {
  if (looked.has(control))
    return

  looked.add(control)

  if ((described.getAttribute('aria-describedby') ?? '').split(SPACES).includes(links.issues))
    control.removeAttribute(control.getAttribute('role') === 'group' ? 'data-invalid' : 'aria-invalid')
}

export interface FieldLinks {
  // Marks the field's frame, for the link to find its control: a `ref` would make the component an island.
  frame: string
  // The id of the label's text, which names a choice group.
  label: string
  hint: string
  issues: string
  // What describes the field: the hint, and the messages while there are any.
  described: () => string[]
}

// A FormField's ids, and the link from its control to its hint and messages: kept in the control's `aria-describedby` beside the page's own ids, and `aria-invalid` while a message shows.
// A required field's control, each field of a group, takes `aria-required` unless the page set one, since the star beside the label is hidden from a screen reader, and the native `required`, which the browser's validation and a post with no JavaScript know.
// A group has no control of its own: while a message shows, each field in it is marked invalid and described by the message, so `focusInvalid` reaches the group's first field.
// The control is the page's own markup: the server hands it the ids as it renders, and inside an island the browser keeps the link as the messages change; drawn here rather than in the component, which stays static on a page of its own.
export function fieldLinks(group: () => boolean, hint: () => boolean, messages: () => readonly unknown[], required: () => boolean = () => false): FieldLinks {
  const links: FieldLinks = { frame: uid(), label: uid(), hint: uid(), issues: uid(), described: () => [hint() ? links.hint : undefined, messages().length > 0 ? links.issues : undefined].filter(id => id !== undefined) }

  // A static page renders the field outside any island, where nothing drops the effect as an island's server render does.
  if (typeof document === 'undefined') {
    describeField(group() ? '' : links.described().join(' '), { required: required() && (group() ? 'all' : true), invalid: messages().length > 0 && (group() ? 'all' : true) })

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

      for (const field of fieldsOf(links.frame))
        unrequireField(field)
    }

    const ours = links.described()
    const invalid = messages().length > 0
    const control = controlOf(document.querySelector(`[data-kui-field="${links.frame}"] > label`))

    if (!control)
      return

    releaseServerMark(control, links)

    const choice = control.matches(CHOICE)

    if (choice && !control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby'))
      control.setAttribute('aria-labelledby', links.label)

    const own = (control.getAttribute('aria-describedby') ?? '').split(SPACES).filter(id => id !== '' && id !== links.hint && id !== links.issues)
    const all = [...own, ...ours]

    if (all.length > 0)
      control.setAttribute('aria-describedby', all.join(' '))
    else
      control.removeAttribute('aria-describedby')

    if (required() && (!choice || control.getAttribute('role') === 'radiogroup'))
      requireField(control, false)
    else
      unrequireField(control)

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

// The input types the native `required` does not apply to.
const UNCONSTRAINABLE = new Set(['range', 'color'])

// A group of checkboxes takes `aria-required` alone, as the browser would ask for every box to be ticked.
function requireField(field: HTMLElement, grouped: boolean): void {
  const type = field instanceof HTMLInputElement ? field.type : ''

  if (!field.hasAttribute('aria-required') && !UNREQUIRABLE.has(type)) {
    field.setAttribute('aria-required', 'true')
    requiredByUs.add(field)
  }

  if (!field.hasAttribute('required') && !UNCONSTRAINABLE.has(type) && !(grouped && type === 'checkbox')) {
    field.setAttribute('required', '')
    nativeByUs.add(field)
  }
}

// Takes back what `requireField` set, once the field stops being required or the group stops being one.
function unrequireField(field: HTMLElement): void {
  if (requiredByUs.delete(field))
    field.removeAttribute('aria-required')

  if (nativeByUs.delete(field))
    field.removeAttribute('required')
}

// The fields the group marked, which it clears once its message does; `markInvalid` leaves one the page or a refused post still marks.
function markGroup(links: FieldLinks, shown: boolean, marked: Set<HTMLElement>, required: boolean): void {
  for (const field of fieldsOf(links.frame)) {
    releaseServerMark(field, links, document.querySelector(`[data-kui-field="${links.frame}"]`) ?? field)

    if (required)
      requireField(field, true)
    else
      unrequireField(field)

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

// The messages shown for one field: those its form's last call was refused with under `name`, else the one its `form(action)` holds for it, then the page's own `issue`, none twice and none empty. Read in a component's script, where the form's context is.
// A Form, FormDialog or SaveForm gives `formIssues` and clears it itself, so the action's own error, which stays until a call succeeds, is not read beside it.
export function fieldIssues(name: () => string | undefined, issue: () => string | undefined): () => string[] {
  const list = fieldIssueList(name, issue)

  return () => list().map(item => item.message)
}

// The first refusal of an item of the array a field holds, `tags.1` or `tags[1]`, which an action's handler gives a single entry of a list (a schema's own refusal comes under the field's name): shown under the list's field as its own message; with several refused items, the first key of the refusal wins.
function itemRefusal(all: Record<string, string>, field: string): string | undefined {
  const key = Object.keys(all).find(name => name.startsWith(field) && ITEM.test(name.slice(field.length)))

  return key === undefined ? undefined : all[key]
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
  const read = (field: string) => refused ? (refused()[field] ?? itemRefusal(refused(), field)) : held(field)

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
