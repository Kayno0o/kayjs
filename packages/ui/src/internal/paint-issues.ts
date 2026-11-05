import { markInvalid, uid } from 'kay'
import { FIELD_MESSAGE, liveElements } from '../field-look'
import { CONTROL, fieldsOf } from '../forms'

const SPACES = /\s+/

// What holds the `aria-invalid` of a control whose message was written here.
const PAINTED = {}

// The class of an issue message of each field, seen before it was taken away, for the next message to wear.
const classes = new WeakMap<Element, string>()
// The fields whose server-rendered messages were taken over.
const adopted = new WeakSet<Element>()

// The controls a message field names, none for a field that draws its own messages (a component running in the browser) or that another one shows: a Checkbox or Toggle inside a FormField of the same name.
function controlsOf(field: Element, name: string): HTMLElement[] | undefined {
  const parent = field.parentElement

  if (parent?.hasAttribute('data-kui-field')) {
    if (liveElements.has(parent))
      return undefined

    if (parent.tagName === 'FIELDSET')
      return fieldsOf(parent.getAttribute('data-kui-field')!)

    const control = parent.querySelector(':scope > label')?.querySelector<HTMLElement>(CONTROL)

    return control ? [control] : []
  }

  const frame = field.closest('[data-kui-field]')

  if (frame?.querySelector(':scope > [data-field]')?.getAttribute('data-field') === name)
    return undefined

  // A Checkbox or Toggle is an island of its own on a static page, which knows no form around it and so draws no message; inside an island of the app it draws its own.
  const host = parent?.parentElement?.getAttribute('data-component') ?? ''
  const box = parent?.querySelector<HTMLInputElement>(':scope > label > input[type="checkbox"]')

  return box && (host.endsWith('/checkbox.kay') || host.endsWith('/toggle.kay')) ? [box] : undefined
}

// Writes `byField` into the message fields of the FormFields, Checkboxes and Toggles a static page gave `form`: the message of a field, replaced or taken away with the `aria-invalid` and `aria-describedby` of its control, the message of the page's own `issue` left in place.
// The server marks the messages of the form with `data-form-issue`, so a call's refusal takes the place of the one a refused post rendered. A hostile message is set as text.
export function paintIssues(form: HTMLFormElement, byField: Record<string, string>): void {
  for (const field of form.querySelectorAll<HTMLElement>('[data-field]')) {
    const name = field.getAttribute('data-field')

    if (name === null || name === '' || field.closest('form') !== form)
      continue

    const controls = controlsOf(field, name)

    if (controls)
      paintField(form, field, controls, byField[name] === '' ? undefined : byField[name])
  }
}

function paintField(form: HTMLFormElement, field: HTMLElement, controls: HTMLElement[], wanted: string | undefined): void {
  const painted = [...field.children].filter(child => child.hasAttribute('data-form-issue'))
  const sample = field.querySelector(':scope > [data-part="issue"]')

  if (sample)
    classes.set(field, sample.className)

  // The server's mark of a refused field is taken over, so it goes once the message does.
  if (!adopted.has(field)) {
    adopted.add(field)

    if (painted.length > 0) {
      for (const control of controls) {
        control.removeAttribute('aria-invalid')
        markInvalid(control, PAINTED, true)
      }
    }
  }

  if (painted.length === (wanted === undefined ? 0 : 1) && painted[0]?.textContent === (wanted ?? undefined))
    return

  for (const message of painted)
    message.remove()

  if (wanted !== undefined && ![...field.children].some(child => child.textContent === wanted)) {
    const message = document.createElement('span')

    message.className = classes.get(field) ?? form.querySelector('[data-part="issue"]')?.className ?? FIELD_MESSAGE.issue
    message.setAttribute('data-part', 'issue')
    message.setAttribute('data-form-issue', '')
    message.textContent = wanted
    field.prepend(message)
  }

  const shown = field.childElementCount > 0
  const was = field.id
  const id = was || uid()
  const described = field.parentElement?.tagName === 'FIELDSET' && field.parentElement.hasAttribute('data-kui-field') ? [...controls, field.parentElement] : controls

  for (const control of described) {
    const ids = (control.getAttribute('aria-describedby') ?? '').split(SPACES).filter(known => known !== '' && known !== was)

    if (shown)
      ids.push(id)

    if (ids.length > 0)
      control.setAttribute('aria-describedby', ids.join(' '))
    else
      control.removeAttribute('aria-describedby')
  }

  for (const control of controls)
    markInvalid(control, PAINTED, shown)

  if (shown)
    field.id = id
  else
    field.removeAttribute('id')
}
