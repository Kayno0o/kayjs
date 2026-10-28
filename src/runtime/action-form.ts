import type { Action, HoneypotOf } from './action-shared'
import { honeypotField, minTimeOf } from './action-protection'
import { isAction } from './action-shared'
import { escapeAttribute } from './escape'
import { holdInvalid } from './invalid'
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

// The field carrying when a form posting to an action with `minTime` rendered.
export const STAMP_FIELD = 'kay_since'

// Signs that stamp, or gives back the one a refused post sent while it is still good; the server sets it, holding the secret.
let stamper: ((action: string, sent: string | undefined, maxAge: number) => string) | undefined

// What a form posting to `target` renders besides its own fields: the honeypot, out of sight and out of reach of the keyboard, screen readers and password managers, whose autofill would otherwise refuse a person, and the stamp `minTime` reads.
export function formProtection(target: unknown): string {
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
