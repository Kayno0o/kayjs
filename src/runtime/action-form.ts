import type { Action, HoneypotOf } from './action-shared'
import { honeypotField, minTimeOf } from './action-protection'
import { isAction } from './action-shared'
import { claimedHost } from './claimed'
import { escapeAttribute } from './escape'
import { holdInvalid } from './invalid'
import { KEPT_END, KEPT_START } from './markers'
import { untrack } from './reactive'

const SPACES = /\s+/

// The actions the forms of the page being rendered post to, for the server to send their schemas along; set while it renders.
let renderedForms: Set<Action<never, unknown>> | undefined

export function collectForms<T>(render: () => T): { result: T, forms: Set<Action<never, unknown>> } {
  const forms = new Set<Action<never, unknown>>()
  const previous = renderedForms

  renderedForms = forms

  try {
    return { result: render(), forms }
  }
  finally {
    renderedForms = previous
  }
}

// The query of an action's URL carrying the fields `with` fixes, as a form's own encoding of them.
export const PAYLOAD_PARAM = 'kay_with'

// Fields as a form posts them: text, numbers, booleans and dates as text, a list as one entry per item, nothing for undefined and null.
function payloadQuery(fields: Record<string, unknown>): string {
  const query = new URLSearchParams()

  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null)
        continue

      if (typeof item === 'object' && !(item instanceof Date))
        throw new TypeError(`kay: ${name} in \`with()\` is neither text, a number, a boolean, a date nor a list of them`)

      query.append(name, item instanceof Date ? item.toISOString() : String(item))
    }
  }

  return query.toString()
}

// The same action for a form to post with `fields` fixed, a further `with` adding to them; its other readings are the action's own.
export function withFields<Target extends object>(target: Target, fields: Record<string, unknown>): Target {
  const query = payloadQuery(fields)

  // The URL a form posts to, which the action's own `url` stays apart from: the stamp and the protections name that one.
  // Over a function of its own, whose properties the traps may answer differently from the action's, which holds `with` read-only.
  return new Proxy((() => undefined) as unknown as Target, {
    get: (_, key) => {
      if (key === 'with')
        return (more: Record<string, unknown>) => withFields(target, { ...fields, ...more })

      return key === 'formUrl' ? `${(target as { url: string }).url}?${PAYLOAD_PARAM}=${encodeURIComponent(query)}` : Reflect.get(target, key)
    },
    apply: (_, self, args: unknown[]): unknown => Reflect.apply(target as unknown as () => unknown, self, args),
    has: (_, key) => key in target,
  })
}

export function formAction(target: string | Action<never, unknown>): string {
  if (typeof target === 'string')
    return target

  renderedForms?.add(target)

  return (target as { formUrl?: string }).formUrl ?? target.url
}

export type FieldName<Target> = Target extends Action<infer Input, unknown> ? Extract<keyof Input, string> | HoneypotOf<Target> : string

// An action as the fields of a form posting to it read it, whatever its input.
type FormTarget = Action<Record<string, unknown>, unknown>

// What a refused post sent for a field of a form posting to `target`, to show it again; undefined without one, and for the honeypot.
export function formValue(target: unknown, name: string): string | undefined {
  if (!isAction(target) || name === honeypotField(target.protection))
    return undefined

  return untrack((target as FormTarget).failed)?.values[name]
}

// The actions of the forms being rendered, the innermost last, which a component inside one reads to show a refused post's values again.
const enclosing: unknown[] = []

// Renders a form's content with the form's action as the one `postedValue`, `postedChecked` and `formErrors` read.
// `only` is for a component given an `action`: a value that is no action (a snippet, a toast's action object) leaves the form around it in place, where a form's plain URL shadows it.
export function formScope<Result>(target: unknown, render: () => Result, only = false): Result {
  if (only && !isAction(target))
    return render()

  // A component given the action, such as a SaveForm that calls it, has the page carry its schema too, for `action.validate`.
  if (only && isAction(target))
    renderedForms?.add(target)

  enclosing.push(target)

  try {
    return issueScope(target, render)
  }
  finally {
    enclosing.pop()
  }
}

// The actions of the forms being rendered in the browser, whose messages `formErrors` reads: a component of an island's template knows its form by this, where `postedValue` keeps reading the server's markup.
const reading: unknown[] = []

// Renders a form's content with the form's action as the one `formErrors` reads, `only` as `formScope` takes it.
// An island's own template on the server renders with none, as in the browser a page's form is not known to it.
export function issueScope<Result>(target: unknown, render: () => Result, only = false): Result {
  if (only && !isAction(target))
    return render()

  reading.push(target)

  try {
    return render()
  }
  finally {
    reading.pop()
  }
}

// The messages of the form being rendered, its action's `error(field)`, for a component drawing a field to show them without an `issue` prop: taken in the component's script, where the form is known, and read later, in an effect or a template.
// The server's render, and a component an island's template calls inside a `form(action)`, both know the form; outside one, or for a plain URL, no field has a message.
// kept: free, as `postedValue` is.
export function formErrors(): (field: string) => string | undefined {
  const target = reading.at(-1)

  return isAction(target) ? field => (target as FormTarget).error(field) : () => undefined
}

const QUOTES = /["\\]/g

// The fields named `name` in the markup the server wrote for the island being hydrated, none outside a hydration.
function claimedFields(name: string): Element[] {
  const host = claimedHost() as Element | undefined

  return host?.querySelectorAll ? [...host.querySelectorAll(`[name="${name.replace(QUOTES, '\\$&')}"]`)] : []
}

// The text the server wrote into a field: a box's `value` attribute, a textarea's text, a select's chosen option, a group of radios' ticked one.
function claimedValue(fields: Element[]): string | undefined {
  const first = fields[0]

  if (!first)
    return undefined

  if (first instanceof HTMLSelectElement)
    return [...first.options].find(option => option.defaultSelected)?.value

  if (first instanceof HTMLInputElement && first.type === 'radio')
    return (fields as HTMLInputElement[]).find(radio => radio.defaultChecked)?.value

  return (first as HTMLInputElement | HTMLTextAreaElement).defaultValue
}

// What a refused post sent for the field `name` of the form being rendered, for a component drawing a field to start from; undefined outside a form posting to an action, without a refusal, for a password or a secret, and in the browser, where the server's markup is claimed as it is.
// kept: free, a refused post's values come with its flash cookie, and a page rendered with one is never kept.
export function postedValue(name: unknown, fallback?: unknown): string | undefined {
  if (typeof name !== 'string' || name === '')
    return undefined

  if (isAction(enclosing.at(-1)))
    return formValue(enclosing.at(-1), name)

  // Hydrating, the browser holds only the markup the server wrote from the refusal; the value counts when it is not the one the component starts with anyway.
  const written = claimedValue(claimedFields(name))

  return written === undefined || written === String(fallback ?? '') ? undefined : written
}

// Whether a checkbox or radio button named `name` was ticked in the refused post, `value` being the one it posts when ticked; undefined as `postedValue` is.
// kept: free, as `postedValue` is.
export function postedChecked(name: unknown, value?: string | number, fallback = false): boolean | undefined {
  if (typeof name !== 'string' || name === '')
    return undefined

  if (isAction(enclosing.at(-1)))
    return formChecked(enclosing.at(-1), name, value)

  const box = (claimedFields(name) as HTMLInputElement[]).find(field => value === undefined || field.value === String(value))

  return box === undefined || box.defaultChecked === fallback ? undefined : box.defaultChecked
}

// The values of a field a refused post sent more than once, flashed as a JSON list under `<name>[]`; undefined when it sent one value or none, an empty list when the list cannot be read.
function postedList(posted: Partial<Record<string, string>>, name: string): string[] | undefined {
  const list = posted[`${name}[]`]

  if (list === undefined)
    return undefined

  try {
    const parsed: unknown = JSON.parse(list)

    return Array.isArray(parsed) ? parsed.map(String) : []
  }
  catch {
    return []
  }
}

// Every value a refused post sent for the field `name` of the form being rendered, such as the choices of a group of checkboxes, none when it sent none; undefined as `postedValue` is.
// kept: free, as `postedValue` is.
export function postedValues(name: unknown, fallback?: readonly unknown[]): string[] | undefined {
  const target = enclosing.at(-1)

  if (!isAction(target)) {
    const fields = typeof name === 'string' && name !== '' ? claimedFields(name) as HTMLInputElement[] : []
    const written = fields.filter(field => field.type !== 'checkbox' || field.defaultChecked).map(field => field.type === 'checkbox' ? field.value : field.defaultValue)
    const held = (fallback ?? []).map(String)

    // A group posting nothing for none has no field to read: its root says it was refilled.
    if (fields.length === 0)
      return typeof name === 'string' && held.length > 0 && (claimedHost() as Element | undefined)?.querySelector?.(`[data-posted="${name.replace(QUOTES, '\\$&')}"]`) ? [] : undefined

    return (written.length === held.length && written.every(item => held.includes(item))) ? undefined : written
  }

  const posted = typeof name === 'string' && name !== '' && isAction(target) ? untrack((target as FormTarget).failed)?.values : undefined

  // A refusal that read no field, such as a body too large, has nothing to choose.
  if (!posted || Object.keys(posted).length === 0)
    return undefined

  const one = posted[name as string]

  return postedList(posted, name as string) ?? (one === undefined ? [] : [one])
}

// The field carrying when a form posting to an action with `minTime` rendered.
export const STAMP_FIELD = 'kay_since'

// Signs that stamp, or gives back the one a refused post sent while it is still good; the server sets it, holding the secret.
let stamper: ((action: string, sent: string | undefined, maxAge: number) => string) | undefined

// What a form posting to `target` renders besides its own fields: the honeypot, out of sight and out of reach of the keyboard, screen readers and password managers, whose autofill would otherwise refuse a person, and the stamp `minTime` reads.
// `kept` is an island's: its markup sits between comments the browser finds, as the template that claims the form's content has no node for it.
export function formProtection(target: unknown, kept = false): string {
  const markup = protectionMarkup(target)

  return kept && markup !== '' ? `<!--${KEPT_START}-->${markup}<!--${KEPT_END}-->` : markup
}

function protectionMarkup(target: unknown): string {
  if (!isAction(target))
    return ''

  const field = honeypotField(target.protection)
  const honeypot = field === undefined ? '' : `<div style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden" aria-hidden="true" inert><input name="${escapeAttribute(field)}" type="text" tabindex="-1" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div>`

  if (target.protection?.minTime === undefined || !stamper)
    return honeypot

  // A refused post keeps the time its form rendered at, so the visitor is not sent back to zero.
  const sent = untrack((target as FormTarget).failed)?.values[STAMP_FIELD]

  return `${honeypot}<input type="hidden" name="${STAMP_FIELD}" value="${escapeAttribute(stamper(target.url, sent, minTimeOf(target.protection)!.maxAge))}">`
}

export function setStamper(sign: typeof stamper): void {
  stamper = sign
}

// Whether a checkbox or radio button was ticked in a refused post; undefined without one. One with no `value` posts `on`, read as `true` by a boolean field.
export function formChecked(target: unknown, name: string, value: unknown): boolean | undefined {
  const posted = isAction(target) ? untrack((target as FormTarget).failed)?.values : undefined

  // A refusal that read no field, such as a body too large, has nothing to tick or untick.
  if (!posted || Object.keys(posted).length === 0)
    return undefined

  const list = posted[name] === undefined ? postedList(posted, name) : undefined

  if (list)
    return list.includes(value === undefined ? 'on' : String(value))

  return value === undefined ? posted[name] !== undefined && posted[name] !== 'false' : posted[name] === String(value)
}

// `aria-invalid` for a field a refused post or call got an error for.
export function formInvalid(target: unknown, name: string): 'true' | undefined {
  return isAction(target) && (target as FormTarget).error(name) !== undefined ? 'true' : undefined
}

// What holds the mark of a refused field in an island, beside a component marking the same control.
const REFUSED = {}

// Marks an island field `aria-invalid` while a refused post or call gave `field` of a form posting to `target` a message, and takes kay's mark off once there is none, leaving one a component still holds.
// The template writes no `aria-invalid` on a field kay marks, so one found is the server's render of this same refusal.
export function formMarked(element: Element, target: unknown, field: string): void {
  holdInvalid(element, REFUSED, formError(target, field) !== undefined, false)
}

// Adds `id` to an island field's `aria-describedby` while a refused post or call gave `field` of a form posting to `target` a message (`''` for the form's own), and takes it out once there is none, leaving the ids others wrote there.
export function formDescribed(element: Element, target: unknown, field: string, id: string): void {
  const ids = (element.getAttribute('aria-describedby') ?? '').split(SPACES).filter(name => name !== '')
  const refused = formError(target, field) !== undefined

  if (refused === ids.includes(id))
    return

  const next = refused ? [...ids, id] : ids.filter(name => name !== id)

  if (next.length > 0)
    element.setAttribute('aria-describedby', next.join(' '))
  else
    element.removeAttribute('aria-describedby')
}

// The message a refused post or call gave `field` of a form posting to `target`, or under '' the form's own: what an `error` line shows.
export function formError(target: unknown, field: string): string | undefined {
  return isAction(target) ? (target as FormTarget).error(field) : undefined
}
