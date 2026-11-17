import type { TSchema } from 'elysia'
import type { FormRules } from './field-refusal'
import { fieldMessage } from './field-refusal'
import { focusInvalid } from './focus'
import { formInput } from './form'
import { controlsOf } from './form-controls'
import { markInvalid } from './invalid'
import { ISLAND } from './markers'
import { uid } from './uid'

export type { FieldRules, FormRules } from './field-refusal'

// The schemas of the actions a page's forms post to, by action path, in one JSON script of the page's head, and one more after each streamed block bringing forms the page lacked.
export const FORMS_SCRIPT = 'script[data-kay-forms]'

// Checks a form against the schema of the action it posts to, as the server would, reporting each refused field with the message the server would give; true when it may post.
export function checkForm(form: HTMLFormElement, action: string): boolean {
  const rules = formRules(action)

  if (!rules)
    return true

  let valid = true

  for (const { control, message } of checked(form, rules)) {
    control.setCustomValidity(message ?? '')

    if (message !== undefined) {
      valid = false
      control.addEventListener('input', () => control.setCustomValidity(''), { once: true })
    }
  }

  if (!valid)
    HTMLFormElement.prototype.reportValidity.call(form)

  return valid
}

// What holds the `aria-invalid` of a control a `validate` form refused.
const PAINTED = {}

// A form written with `validate` shows what the schema refuses as text where the page put a place for it, not as the browser's bubble: checks the form (or `only` its field) like `checkForm` and writes each message into the element carrying `data-field="<name>"`, the control marked invalid and described by it. True when it may post; a refusal of the whole form focuses its first invalid field.
// The elements inside an island are left to it, which draws the messages of its own.
export function validateForm(form: HTMLFormElement, action: string, only?: string): boolean {
  const messages = fieldMessages(form, action, only)

  if (!messages)
    return true

  for (const box of form.querySelectorAll<HTMLElement>('[data-field]')) {
    const name = box.getAttribute('data-field') ?? ''

    if (name === '' || (only !== undefined && only !== name) || box.closest('form') !== form || box.closest(ISLAND))
      continue

    paintMessage(form, box, name, messages[name])
  }

  const valid = Object.keys(messages).length === 0

  if (!valid && only === undefined)
    void focusInvalid(form)

  return valid
}

function paintMessage(form: HTMLFormElement, box: HTMLElement, name: string, message: string | undefined): void {
  const control = controlOf(form, name)
  const shown = [...box.children].filter(child => child.hasAttribute('data-form-issue'))
  const sample = shown[0]?.className ?? box.getAttribute('data-issue-class') ?? ''

  // A message the server rendered goes with its mark, taken over as the first message is written or cleared here.
  if (shown.length > 0) {
    control?.removeAttribute('aria-invalid')
    control?.removeAttribute('data-invalid')
  }

  for (const old of shown)
    old.remove()

  if (message !== undefined) {
    const line = document.createElement('span')

    line.setAttribute('data-part', 'issue')
    line.setAttribute('data-form-issue', '')
    line.className = sample
    line.textContent = message
    box.prepend(line)
    box.id ||= uid()
  }

  if (!control)
    return

  const ids = (control.getAttribute('aria-describedby') ?? '').split(' ').filter(id => id !== '' && id !== box.id)

  if (message !== undefined)
    ids.push(box.id)

  if (ids.length > 0)
    control.setAttribute('aria-describedby', ids.join(' '))
  else
    control.removeAttribute('aria-describedby')

  markInvalid(control, PAINTED, message !== undefined)
}

// The messages the schema of the action at `action` refuses the fields of a form with, by field name, none for a field it accepts: all the fields, or `only` alone. Undefined when the page holds no schema for the action. Nothing is reported on the form, for a page to show the messages itself.
export function fieldMessages(form: HTMLFormElement, action: string, only?: string): Record<string, string> | undefined {
  const rules = formRules(action)

  if (!rules)
    return undefined

  const messages: Record<string, string> = {}

  for (const { name, message } of checked(form, rules, only)) {
    if (message !== undefined)
      messages[name] = message
  }

  return messages
}

// Each field of the form the check reaches, with the control the message is shown on and the message it is refused with, undefined for a field it accepts.
function checked(form: HTMLFormElement, rules: FormRules, only?: string): { name: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, message: string | undefined }[] {
  const data = new FormData(form)
  const body: Record<string, unknown> = {}

  for (const name of new Set(data.keys())) {
    const values = data.getAll(name)

    body[name] = values.length === 1 ? values[0] : values
  }

  const fields = formInput(rules as unknown as TSchema, body) as Record<string, unknown>
  const found = []

  for (const [name, field] of Object.entries(rules.properties)) {
    const control = controlOf(form, name)

    // A file is checked by its bytes, and a hidden field's message would show nowhere: both are the server's.
    if ((only !== undefined && only !== name) || !control || (control instanceof HTMLInputElement && (control.type === 'file' || control.type === 'hidden')))
      continue

    const value = fields[name]

    found.push({ name, control, message: value === undefined ? undefined : fieldMessage(name, field, value) })
  }

  return found
}

function formRules(action: string): FormRules | undefined {
  for (const script of document.querySelectorAll(FORMS_SCRIPT)) {
    try {
      const rules = (JSON.parse(script.textContent ?? '{}') as Record<string, FormRules>)[action]

      if (rules)
        return rules
    }
    catch {
      // A script still streaming does not parse yet: the next check reads it whole.
    }
  }

  return undefined
}

// The first control posting under `name`, the one a message is shown on.
function controlOf(form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined {
  const found = controlsOf(form).namedItem(name)
  const control = found instanceof RadioNodeList ? found[0] : found

  return control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement ? control : undefined
}
